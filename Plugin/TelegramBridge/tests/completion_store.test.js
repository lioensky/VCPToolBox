'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createCompletionStore, CompletionStoreError } = require('../src/completionStore');
const { createSessionStore } = require('../src/sessionStore');

function assertStoreError(error, code) {
  assert.equal(error instanceof CompletionStoreError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

function fixture(t, storeOptions = {}) {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-completion-'));
  const stateDir = path.join(pluginRoot, 'state');
  const session = createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    clock: (() => { let now = 1000; return () => now++; })(),
    randomUUID: (() => { let value = 0; return () => `uuid-${++value}`; })(),
  });
  session.open();
  const scope = session.getOrCreateScope({ chatId: '42', threadId: '0' });
  const ledger = session.createUpdateLedger();
  ledger.acceptBatch([{ updateId: '10', updateType: 'message', payload: { update_id: 10 } }]);
  ledger.authorizeAndQueue('10', {
    requestId: 'request-10',
    messageId: 'message-10',
    scopeKey: scope.key,
    orderingKey: 'telegram:42:0',
    ownerUserId: '42',
    replayPolicy: 'manual',
  });
  ledger.claimRequest('request-10', 'worker-1');
  ledger.markEffectStarted('request-10');

  const databasePath = path.join(stateDir, 'telegram.sqlite3');
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  const store = createCompletionStore(db, {
    clock: (() => { let now = 2000; return () => now++; })(),
    ...storeOptions,
  });
  t.after(() => {
    db.close();
    session.close();
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  });
  return { db, ledger, scope, session, store };
}

function completionInput(overrides = {}) {
  return {
    requestId: 'request-10',
    turnId: 'turn-10',
    userText: 'question',
    assistantText: '**answer**',
    userTelegramMessageId: '77',
    segments: [{
      text: '<b>answer</b>',
      plainText: '**answer**',
      parseMode: 'HTML',
    }],
    ...overrides,
  };
}

test('durable failure-notice keys can be claimed and confirmed without replaying a request',t=>{
  const f=fixture(t);const key='notice-'+'a'.repeat(64);
  f.db.prepare(`INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,status,attempt,created_at,updated_at,payload_json,effect_state)
    VALUES(?,?,'failure_notice','telegram_notice','request-10','pending',0,1,1,?,'not_started')`)
    .run(key,f.scope.key,JSON.stringify({text:'failed',plainText:'failed',parseMode:null}));
  assert.equal(f.store.claimDelivery(key).changed,true);
  assert.equal(f.store.markDeliveryDelivered(key,'700').status,'delivered');
  assert.equal(f.store.claimDelivery(key).changed,false);
});

test('staged documents persist root-qualified descriptors and cannot invent roots', t => {
  const { store, db } = fixture(t);
  const media = { mediaKind: 'document', relativePath: 'generated-report.txt', mime: 'text/plain',
    size: 12, sha256: 'b'.repeat(64), alt: 'report', storageRoot: 'outbox' };
  const result = store.commitCompletion(completionInput({ media: [media] }));
  const payload = JSON.parse(db.prepare('SELECT payload_json FROM deliveries WHERE idempotency_key=?').get(result.mediaDeliveryKeys[0]).payload_json);
  assert.equal(payload.storageRoot, 'outbox');
  assert.equal(payload.mediaKind, 'document');
  assert.throws(() => store.commitCompletion(completionInput({ media: [{ ...media, storageRoot: 'secret' }] })));
});

test('migration 003 adds stream-delivery columns and draft ID persists across store instances', (t) => {
  const { db, store } = fixture(t);
  const requestColumns = db.prepare('PRAGMA table_info(requests)').all().map((row) => row.name);
  const deliveryColumns = db.prepare('PRAGMA table_info(deliveries)').all().map((row) => row.name);
  assert.ok(requestColumns.includes('telegram_draft_id'));
  assert.ok(requestColumns.includes('completion_sha256'));
  for (const column of ['segment_index', 'payload_json', 'payload_sha256', 'effect_state']) {
    assert.ok(deliveryColumns.includes(column));
  }

  const first = store.getOrCreateDraftId('request-10');
  const second = createCompletionStore(db, { clock: () => 3000 }).getOrCreateDraftId('request-10');
  assert.equal(Number.isSafeInteger(first), true);
  assert.ok(first > 0);
  assert.equal(second, first);
  assert.equal(db.prepare('SELECT telegram_draft_id FROM requests WHERE request_id = ?')
    .get('request-10').telegram_draft_id, first);
});

test('one transaction stores a logical turn, completes the request and creates idempotent segments', (t) => {
  const { db, store } = fixture(t);
  const first = store.commitCompletion(completionInput());
  assert.deepEqual(first, { changed: true, deliveryKeys: [first.deliveryKeys[0]] });

  const request = db.prepare(`
    SELECT status, effect_state, finished_at FROM requests WHERE request_id = ?
  `).get('request-10');
  assert.equal(request.status, 'completed');
  assert.equal(request.effect_state, 'confirmed');
  assert.equal(Number.isSafeInteger(request.finished_at), true);
  assert.equal(db.prepare('SELECT status FROM updates WHERE update_id = ?').get('10').status, 'completed');

  const messages = db.prepare(`
    SELECT role, content_json, turn_id, position FROM messages ORDER BY position
  `).all();
  assert.deepEqual(messages.map((row) => ({
    role: row.role,
    content: JSON.parse(row.content_json),
    turnId: row.turn_id,
    position: row.position,
  })), [
    { role: 'user', content: 'question', turnId: 'turn-10', position: 0 },
    { role: 'assistant', content: '**answer**', turnId: 'turn-10', position: 1 },
  ]);

  const deliveries = db.prepare(`
    SELECT idempotency_key, status, effect_state, segment_index, payload_json
    FROM deliveries ORDER BY segment_index
  `).all();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].idempotency_key, first.deliveryKeys[0]);
  assert.equal(deliveries[0].status, 'pending');
  assert.equal(deliveries[0].effect_state, 'not_started');
  assert.deepEqual(JSON.parse(deliveries[0].payload_json), {
    text: '<b>answer</b>', plainText: '**answer**', parseMode: 'HTML', segmentIndex: 0,
  });

  const replay = store.commitCompletion(completionInput());
  assert.deepEqual(replay, { changed: false, deliveryKeys: first.deliveryKeys });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
  assert.throws(
    () => store.commitCompletion(completionInput({ userText: 'different question' })),
    (error) => assertStoreError(error, 'COMPLETION_IDEMPOTENCY_COLLISION'),
  );
});

test('completion insertion preserves history bounds by pruning only whole oldest turns', (t) => {
  const { db, session, scope, store } = fixture(t, {
    historyMaxMessages: 2,
    historyMaxBytes: 4096,
  });
  session.appendTurn({
    scopeKey: scope.key,
    turnId: 'old-turn',
    messages: [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ],
  });
  store.commitCompletion(completionInput());
  const turns = db.prepare(`
    SELECT turn_id, role FROM messages ORDER BY turn_seq, position
  `).all();
  assert.deepEqual(turns, [
    { turn_id: 'turn-10', role: 'user' },
    { turn_id: 'turn-10', role: 'assistant' },
  ]);
});

test('drafts, placeholders and internal or partial protocol text cannot enter completed history', (t) => {
  const { db, store } = fixture(t);
  for (const text of [
    '…',
    '<<<[TOOL_REQUEST]>>>secret<<<[END_TOOL_REQUEST]>>>',
    '<think>secret</think>',
    '[UPSTREAM_ERROR] secret',
  ]) {
    assert.throws(
      () => store.commitCompletion(completionInput({ assistantText: text })),
      (error) => assertStoreError(error, 'COMPLETION_TEXT_UNSAFE'),
    );
  }
  assert.equal(db.prepare('SELECT status FROM requests WHERE request_id = ?').get('request-10').status, 'processing');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 0);
});

test('delivery claims are CAS protected and unknown network outcome becomes non-retryable needs_review', (t) => {
  const { db, store } = fixture(t);
  const committed = store.commitCompletion(completionInput());
  const key = committed.deliveryKeys[0];

  assert.deepEqual(store.claimDelivery(key), { changed: true, status: 'sending' });
  assert.deepEqual(store.claimDelivery(key), { changed: false, status: 'sending' });
  assert.deepEqual(store.markDeliveryUnknown(key, 'TELEGRAM_NETWORK_UNKNOWN'), {
    changed: true, status: 'needs_review',
  });
  assert.deepEqual(store.listPendingDeliveries(10), []);
  const row = db.prepare(`
    SELECT status, effect_state, last_error_code FROM deliveries WHERE idempotency_key = ?
  `).get(key);
  assert.deepEqual(row, {
    status: 'needs_review', effect_state: 'unknown', last_error_code: 'TELEGRAM_NETWORK_UNKNOWN',
  });
});

test('known successful final send records the exact Telegram message ID once', (t) => {
  const { db, store } = fixture(t);
  const key = store.commitCompletion(completionInput()).deliveryKeys[0];
  store.claimDelivery(key);
  assert.deepEqual(store.markDeliveryDelivered(key, '9007199254740993'), {
    changed: true, status: 'delivered',
  });
  assert.deepEqual(store.markDeliveryDelivered(key, '9007199254740993'), {
    changed: false, status: 'delivered',
  });
  assert.equal(db.prepare('SELECT telegram_message_id FROM deliveries WHERE idempotency_key = ?')
    .get(key).telegram_message_id, '9007199254740993');
});

test('completion atomically persists idempotent rich-media deliveries without secret paths', (t) => {
  const { db, store } = fixture(t);
  const media = [{
    mediaKind: 'photo',
    relativePath: 'ExampleAgent/a.png',
    mime: 'image/png',
    size: 32,
    sha256: 'a'.repeat(64),
    alt: 'fixture image',
  }];

  const first = store.commitCompletion(completionInput({ media }));

  assert.equal(first.changed, true);
  assert.equal(first.mediaDeliveryKeys.length, 1);
  assert.match(first.mediaDeliveryKeys[0], /^media-[a-f0-9]{64}$/);
  const row = db.prepare(`
    SELECT scope_key, source_type, source_key, segment_index, payload_json, effect_state
    FROM deliveries WHERE idempotency_key = ?
  `).get(first.mediaDeliveryKeys[0]);
  assert.equal(row.source_type, 'telegram_rich_media');
  assert.equal(row.source_key, 'request-10');
  assert.equal(row.segment_index, 0);
  assert.equal(row.effect_state, 'not_started');
  assert.deepEqual(JSON.parse(row.payload_json), { ...media[0], mediaIndex: 0 });
  assert.equal(row.payload_json.includes('pw='), false);
  assert.equal(path.isAbsolute(JSON.parse(row.payload_json).relativePath), false);

  assert.deepEqual(store.listPendingMediaDeliveries(10), [{
    idempotencyKey: first.mediaDeliveryKeys[0],
    scopeKey: row.scope_key,
    requestId: 'request-10',
    mediaIndex: 0,
    payload: { ...media[0], mediaIndex: 0 },
    status: 'pending',
    attempt: 0,
  }]);
  store.claimDelivery(first.deliveryKeys[0]);
  store.markDeliveryDelivered(first.deliveryKeys[0], '500');
  assert.equal(store.claimDelivery(first.mediaDeliveryKeys[0]).changed, true);
  assert.deepEqual(store.markDeliveryDelivered(first.mediaDeliveryKeys[0], '501'), {
    changed: true,
    status: 'delivered',
  });

  const replay = store.commitCompletion(completionInput({ media }));
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.mediaDeliveryKeys, first.mediaDeliveryKeys);
});

test('known preview ID is durable only on the first segment and participates in idempotency', t => {
  const { db, store } = fixture(t);
  const input = completionInput({ previewMessageId: '9007199254740993', assistantText: 'firstsecond', segments: [
    { text: 'first', plainText: 'first', parseMode: null },
    { text: 'second', plainText: 'second', parseMode: null },
  ] });
  const committed = store.commitCompletion(input);
  const reopened = createCompletionStore(db);
  const pending = reopened.listPendingDeliveries(10);
  assert.equal(pending[0].payload.previewMessageId, input.previewMessageId);
  assert.equal(Object.hasOwn(pending[1].payload, 'previewMessageId'), false);
  assert.deepEqual(reopened.commitCompletion(input), { changed: false, deliveryKeys: committed.deliveryKeys });
  assert.throws(() => reopened.commitCompletion({ ...input, previewMessageId: '123' }),
    error => assertStoreError(error, 'COMPLETION_IDEMPOTENCY_COLLISION'));
  assert.throws(() => reopened.commitCompletion({ ...input, previewMessageId: undefined }),
    error => assertStoreError(error, 'COMPLETION_IDEMPOTENCY_COLLISION'));
});

test('invalid preview IDs and conflicting preview outcomes fail before storing a turn', t => {
  const { store, db } = fixture(t);
  for (const previewMessageId of [null, '0', '01', '-1', 1, '', 'abc']) {
    assert.throws(() => store.commitCompletion(completionInput({ previewMessageId })),
      error => assertStoreError(error, 'COMPLETION_INPUT_INVALID'));
  }
  assert.throws(() => store.commitCompletion(completionInput({ previewMessageId: '100', previewDeliveryUnknown: true })),
    error => assertStoreError(error, 'COMPLETION_INPUT_INVALID'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
});

test('confirming an edit final requires the persisted preview target ID', t => {
  const { store } = fixture(t);
  const key = store.commitCompletion(completionInput({ previewMessageId: '100' })).deliveryKeys[0];
  store.claimDelivery(key);
  assert.throws(() => store.markDeliveryDelivered(key, '101'),
    error => assertStoreError(error, 'COMPLETION_IDEMPOTENCY_COLLISION'));
  assert.deepEqual(store.markDeliveryDelivered(key, '100'), { changed: true, status: 'delivered' });
});

test('an ambiguous persistent preview atomically quarantines first final and blocks recovery of later text and media', t => {
  const { store, db } = fixture(t);
  const committed = store.commitCompletion(completionInput({
    previewDeliveryUnknown: true, assistantText: 'firstsecond', segments: [
      { text: 'first', plainText: 'first', parseMode: null },
      { text: 'second', plainText: 'second', parseMode: null },
    ], media: [{ mediaKind: 'photo', relativePath: 'ExampleAgent/a.png', mime: 'image/png', size: 32, sha256: 'a'.repeat(64), alt: '' }],
  }));
  const row = db.prepare('SELECT status,effect_state,last_error_code FROM deliveries WHERE idempotency_key=?')
    .get(committed.deliveryKeys[0]);
  assert.deepEqual(row, { status: 'needs_review', effect_state: 'unknown', last_error_code: 'TELEGRAM_PREVIEW_UNKNOWN' });
  assert.equal(store.claimDelivery(committed.deliveryKeys[1]).changed, false);
  assert.equal(store.claimDelivery(committed.mediaDeliveryKeys[0]).changed, false);
  assert.deepEqual(store.listPendingDeliveries(10), []);
  assert.deepEqual(store.listPendingMediaDeliveries(10), []);
});

test('CAS prevents later media from passing an earlier unknown delivery even from an old pending snapshot', t => {
  const { store } = fixture(t);
  const media = { mediaKind: 'photo', relativePath: 'ExampleAgent/a.png', mime: 'image/png', size: 32, sha256: 'a'.repeat(64), alt: '' };
  const committed = store.commitCompletion(completionInput({ media: [media, { ...media, relativePath: 'ExampleAgent/b.png' }] }));
  store.claimDelivery(committed.deliveryKeys[0]);
  store.markDeliveryDelivered(committed.deliveryKeys[0], '100');
  const snapshot = store.listPendingMediaDeliveries(10);
  assert.equal(snapshot.length, 2);
  store.claimDelivery(snapshot[0].idempotencyKey);
  store.markDeliveryUnknown(snapshot[0].idempotencyKey, 'TELEGRAM_MEDIA_NETWORK_UNKNOWN');
  assert.equal(store.claimDelivery(snapshot[1].idempotencyKey).changed, false);
  assert.deepEqual(store.listPendingMediaDeliveries(10), []);
});
