'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createSessionStore } = require('../src/sessionStore');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-session-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  let captured;
  function CapturingDatabase(filename, options) {
    captured = new Database(filename, options);
    return captured;
  }
  let tick = 1000;
  let uuid = 0;
  const store = createSessionStore({
    stateDir,
    pluginRoot,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    DatabaseImpl: CapturingDatabase,
    clock: () => tick++,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    ...overrides,
  });
  store.open();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, getDatabase: () => captured, root, pluginRoot, stateDir };
}

function canonicalEnvelopeBytes({ role, content, telegramMessageId = null }) {
  return Buffer.byteLength(JSON.stringify({ role, content, telegramMessageId }), 'utf8');
}

test('large IDs remain exact strings and scopes switch Agent atomically', (t) => {
  const { store } = fixture(t);
  const chatId = '900719925474099312345';
  const threadId = '900719925474099312346';
  const exampleAgent = store.getOrCreateScope({ chatId, threadId });

  assert.deepEqual(
    {
      key: exampleAgent.key,
      chatId: exampleAgent.chatId,
      threadId: exampleAgent.threadId,
      currentAgent: exampleAgent.currentAgent,
      isActive: exampleAgent.isActive,
    },
    {
      key: `telegram:${chatId}:${threadId}:ExampleAgent`,
      chatId,
      threadId,
      currentAgent: 'ExampleAgent',
      isActive: true,
    },
  );
  assert.equal(typeof exampleAgent.chatId, 'string');
  assert.equal(typeof exampleAgent.threadId, 'string');

  const yuzu = store.switchAgent(exampleAgent.key, 'Yuzu');
  assert.equal(yuzu.key, `telegram:${chatId}:${threadId}:Yuzu`);
  assert.equal(yuzu.isActive, true);
  assert.equal(store.getOrCreateScope({ chatId, threadId, agent: 'ExampleAgent' }).isActive, false);
  assert.equal(store.switchAgent(yuzu.key, 'ExampleAgent').isActive, true);
});

test('restart resolves omitted Agent to persisted active scope while explicit lookup stays exact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-active-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  };

  const first = createSessionStore(options);
  first.open();
  const exampleAgent = first.getOrCreateScope({ chatId: '200', threadId: '7' });
  const yuzu = first.switchAgent(exampleAgent.key, 'Yuzu');
  first.close();

  const restarted = createSessionStore(options);
  restarted.open();
  try {
    assert.equal(restarted.getOrCreateScope({ chatId: '200', threadId: '7' }).key, yuzu.key);
    assert.equal(restarted.getActiveScope({ chatId: '200', threadId: '7' }).key, yuzu.key);
    assert.equal(
      restarted.getOrCreateScope({ chatId: '200', threadId: '7', agent: 'ExampleAgent' }).key,
      exampleAgent.key,
    );
    assert.equal(restarted.getActiveScope({ chatId: '999', threadId: '7' }), null);
  } finally {
    restarted.close();
  }
});

test('new conversation clears only the selected Agent short history', (t) => {
  const { store } = fixture(t);
  const exampleAgent = store.getOrCreateScope({ chatId: '42' });
  store.appendTurn({
    scopeKey: exampleAgent.key,
    turnId: 'exampleAgent-turn',
    messages: [{ role: 'user', content: 'old exampleAgent' }],
  });
  const yuzu = store.switchAgent(exampleAgent.key, 'Yuzu');
  store.appendTurn({
    scopeKey: yuzu.key,
    turnId: 'yuzu-turn',
    messages: [{ role: 'user', content: 'keep yuzu' }],
  });

  const before = exampleAgent.conversationId;
  const renewed = store.startNewConversation(exampleAgent.key);
  assert.notEqual(renewed.conversationId, before);
  assert.deepEqual(store.getHistory(exampleAgent.key), []);
  assert.deepEqual(store.getHistory(yuzu.key).map((message) => message.content), ['keep yuzu']);
});

test('history order is deterministic across complete turns', (t) => {
  const { store } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '77' });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'turn-1',
    messages: [
      { role: 'user', content: 'u1', telegramMessageId: '900719925474099312345' },
      { role: 'assistant', content: { text: 'a1' } },
    ],
  });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'turn-2',
    messages: [{ role: 'tool', content: ['result'] }],
  });

  assert.deepEqual(
    store.getHistory(scope.key).map(({ role, content, turnId, position }) => ({ role, content, turnId, position })),
    [
      { role: 'user', content: 'u1', turnId: 'turn-1', position: 0 },
      { role: 'assistant', content: { text: 'a1' }, turnId: 'turn-1', position: 1 },
      { role: 'tool', content: ['result'], turnId: 'turn-2', position: 0 },
    ],
  );
});

test('message-count pruning removes only whole oldest turns', (t) => {
  const { store } = fixture(t, { historyMaxMessages: 3 });
  const scope = store.getOrCreateScope({ chatId: '100' });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'old',
    messages: [
      { role: 'user', content: 'old-u' },
      { role: 'assistant', content: 'old-a' },
    ],
  });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'new',
    messages: [
      { role: 'user', content: 'new-u' },
      { role: 'assistant', content: 'new-a' },
    ],
  });

  const history = store.getHistory(scope.key);
  assert.deepEqual(history.map((message) => message.turnId), ['new', 'new']);
});

test('UTF-8 byte pruning counts CJK and emoji and keeps whole newest turn', (t) => {
  const newest = '新界🙂';
  const newestBytes = canonicalEnvelopeBytes({ role: 'assistant', content: newest });
  const { store } = fixture(t, { historyMaxBytes: newestBytes + 1 });
  const scope = store.getOrCreateScope({ chatId: '101' });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'old-cjk',
    messages: [{ role: 'user', content: '旧🙂' }],
  });
  store.appendTurn({
    scopeKey: scope.key,
    turnId: 'new-cjk',
    messages: [{ role: 'assistant', content: newest }],
  });

  assert.deepEqual(store.getHistory(scope.key).map((message) => message.content), [newest]);
});

test('history byte limit counts the full canonical serialized message envelope', (t) => {
  const message = { role: 'user', content: 'x' };
  const contentOnlyBytes = Buffer.byteLength(JSON.stringify(message.content), 'utf8');
  const envelopeBytes = canonicalEnvelopeBytes(message);
  assert.ok(envelopeBytes > contentOnlyBytes);
  const { store } = fixture(t, { historyMaxBytes: contentOnlyBytes + 1 });
  const scope = store.getOrCreateScope({ chatId: '106' });

  assert.throws(
    () => store.appendTurn({ scopeKey: scope.key, turnId: 'envelope-too-large', messages: [message] }),
    (error) => error.code === 'HISTORY_TURN_TOO_LARGE',
  );
  assert.deepEqual(store.getHistory(scope.key), []);
});

test('oversized and cyclic turns fail atomically', (t) => {
  const { store } = fixture(t, { historyMaxMessages: 2, historyMaxBytes: 16 });
  const scope = store.getOrCreateScope({ chatId: '102' });

  assert.throws(
    () => store.appendTurn({
      scopeKey: scope.key,
      turnId: 'too-many',
      messages: [
        { role: 'user', content: '1' },
        { role: 'assistant', content: '2' },
        { role: 'tool', content: '3' },
      ],
    }),
    (error) => error.code === 'HISTORY_TURN_TOO_LARGE',
  );
  assert.deepEqual(store.getHistory(scope.key), []);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => store.appendTurn({
      scopeKey: scope.key,
      turnId: 'cyclic',
      messages: [{ role: 'user', content: cyclic }],
    }),
    (error) => error.code === 'HISTORY_INVALID',
  );
  assert.deepEqual(store.getHistory(scope.key), []);
});

test('typed sensitive records are rejected and sentinel is absent from persisted text', (t) => {
  const { store, getDatabase } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '103' });
  const sentinel = 'NEVER-PERSIST-998877';

  for (const message of [
    { role: 'user', kind: 'auth_code', content: sentinel },
    { role: 'assistant', content: { kind: 'approval_callback', value: sentinel } },
    { role: 'tool', content: { nested: { kind: 'approval_payload', value: sentinel } } },
  ]) {
    assert.throws(
      () => store.appendTurn({ scopeKey: scope.key, turnId: `sensitive-${message.role}`, messages: [message] }),
      (error) => error.code === 'HISTORY_SENSITIVE',
    );
  }

  const db = getDatabase();
  for (const table of db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => row.name)) {
    const textColumns = db.prepare(`PRAGMA table_info(${table})`).all()
      .filter((column) => column.type === 'TEXT')
      .map((column) => `COALESCE("${column.name}", '')`);
    if (textColumns.length === 0) continue;
    const rows = db.prepare(`SELECT ${textColumns.join(', ')} FROM "${table}"`).all();
    assert.equal(JSON.stringify(rows).includes(sentinel), false);
  }
});

test('sensitive kinds produced or mutated during serialization are rejected before persistence', (t) => {
  const { store, getDatabase } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '107' });
  const sentinel = 'SERIALIZED-SENSITIVE-223344';

  const viaToJson = {
    toJSON() {
      return { kind: 'approval_payload', value: sentinel };
    },
  };
  const viaAccessor = {};
  Object.defineProperty(viaAccessor, 'trigger', {
    enumerable: true,
    get() {
      viaAccessor.kind = 'auth_code';
      return sentinel;
    },
  });
  viaAccessor.kind = 'safe';

  for (const [turnId, content] of [
    ['to-json-sensitive', viaToJson],
    ['accessor-sensitive', viaAccessor],
  ]) {
    assert.throws(
      () => store.appendTurn({
        scopeKey: scope.key,
        turnId,
        messages: [{ role: 'user', content }],
      }),
      (error) => error.code === 'HISTORY_SENSITIVE',
    );
  }
  assert.deepEqual(store.getHistory(scope.key), []);
  const serializedRows = getDatabase().prepare('SELECT content_json FROM messages').all();
  assert.equal(JSON.stringify(serializedRows).includes(sentinel), false);
});

test('message envelope accessors are snapshotted once before validation and persistence', (t) => {
  const { store } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '108' });
  const reads = { role: 0, content: 0, telegramMessageId: 0 };
  const message = {};
  Object.defineProperties(message, {
    role: {
      enumerable: true,
      get() { reads.role += 1; return 'user'; },
    },
    content: {
      enumerable: true,
      get() { reads.content += 1; return { text: 'snapshot' }; },
    },
    telegramMessageId: {
      enumerable: true,
      get() { reads.telegramMessageId += 1; return '123'; },
    },
  });

  store.appendTurn({ scopeKey: scope.key, turnId: 'snapshot-once', messages: [message] });
  assert.deepEqual(reads, { role: 1, content: 1, telegramMessageId: 1 });
  assert.equal(store.getHistory(scope.key)[0].telegramMessageId, '123');
});

test('all persisted identifier columns preserve large decimal strings', (t) => {
  const { store, getDatabase } = fixture(t);
  const db = getDatabase();
  const id = '900719925474099312345';
  const scope = store.getOrCreateScope({ chatId: id, threadId: `${id}1` });
  const now = 1;

  db.prepare(`INSERT INTO updates
    (update_id, next_offset, update_type, status, scope_key, received_at, updated_at)
    VALUES (?, ?, 'message', 'received', ?, ?, ?)`)
    .run(`${id}2`, `${id}3`, scope.key, now, now);
  db.prepare(`INSERT INTO requests
    (request_id, message_id, update_id, scope_key, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)`)
    .run(`${id}4`, `${id}5`, `${id}2`, scope.key, now, now);
  db.prepare(`INSERT INTO approvals
    (approval_id, request_id, owner_user_id, nonce_hash, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'nonce', 'pending', ?, ?, ?)`)
    .run(`${id}6`, `${id}4`, `${id}7`, now, now, now);
  db.prepare(`INSERT INTO attachments
    (attachment_id, scope_key, request_id, telegram_message_id, telegram_file_id,
     telegram_file_unique_id, relative_path, mime, size, sha256, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'inbox/file', 'text/plain', 1, ?, 'ready', ?, ?)`)
    .run(`${id}8`, scope.key, `${id}4`, `${id}9`, `${id}10`, `${id}11`, 'a'.repeat(64), now, now);
  db.prepare(`INSERT INTO async_tasks
    (task_key, plugin_name, task_id, request_id, scope_key, status, created_at, updated_at)
    VALUES (?, 'Plugin', ?, ?, ?, 'pending', ?, ?)`)
    .run(`Plugin:${id}12`, `${id}12`, `${id}4`, scope.key, now, now);
  db.prepare(`INSERT INTO deliveries
    (idempotency_key, scope_key, kind, source_type, source_key, status, created_at, updated_at)
    VALUES (?, ?, 'message', 'request', ?, 'pending', ?, ?)`)
    .run(`${id}13`, scope.key, `${id}4`, now, now);

  const values = [
    db.prepare('SELECT update_id FROM updates').get().update_id,
    db.prepare('SELECT request_id FROM requests').get().request_id,
    db.prepare('SELECT owner_user_id FROM approvals').get().owner_user_id,
    db.prepare('SELECT telegram_message_id FROM attachments').get().telegram_message_id,
    db.prepare('SELECT task_id FROM async_tasks').get().task_id,
    db.prepare('SELECT source_key FROM deliveries').get().source_key,
  ];
  assert.equal(values.every((value) => typeof value === 'string' && value.startsWith(id)), true);
});

test('a second SQLite connection can write while an unrelated network Promise is pending', async (t) => {
  const { store, stateDir } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '104' });
  let release;
  const delayedNetwork = new Promise((resolve) => { release = resolve; });
  const second = new Database(path.join(stateDir, 'telegram.sqlite3'));
  try {
    second.pragma('busy_timeout = 250');
    second.prepare(`
      INSERT INTO dead_letters (
        dead_letter_id, source_type, source_key, scope_key, safe_error_code, created_at
      ) VALUES ('network-wait-proof', 'test', 'pending', ?, 'TEST_ONLY', 1)
    `).run(scope.key);
    assert.equal(
      second.prepare("SELECT COUNT(*) AS count FROM dead_letters WHERE dead_letter_id = 'network-wait-proof'").get().count,
      1,
    );
  } finally {
    second.close();
    release();
    await delayedNetwork;
  }
});

test('WAL state committed by an abruptly exiting child process recovers on reopen', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-crash-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.resolve(__dirname, '..', 'src', 'sessionStore.js');
  const childScript = `
    const { createSessionStore } = require(${JSON.stringify(modulePath)});
    const store = createSessionStore({
      pluginRoot: ${JSON.stringify(pluginRoot)},
      stateDir: ${JSON.stringify(stateDir)},
      defaultAgent: 'ExampleAgent',
      historyMaxMessages: 40,
      historyMaxBytes: 262144
    });
    store.open();
    const scope = store.getOrCreateScope({ chatId: '300' });
    store.appendTurn({
      scopeKey: scope.key,
      turnId: 'crash-turn',
      messages: [{ role: 'user', content: 'durable-before-exit' }]
    });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);

  const recovered = createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  recovered.open();
  try {
    const scope = recovered.getOrCreateScope({ chatId: '300' });
    assert.deepEqual(recovered.getHistory(scope.key).map((row) => row.content), ['durable-before-exit']);
  } finally {
    recovered.close();
  }
});

test('public surface exposes no raw database or generic transaction and closed status is safe', (t) => {
  const { store, stateDir } = fixture(t);
  assert.deepEqual(Object.keys(store).sort(), [
    'appendTurn',
    'close',
    'createUpdateLedger',
    'getActiveScope',
    'getHistory',
    'getOrCreateScope',
    'getStatus',
    'open',
    'startNewConversation',
    'switchAgent',
  ]);
  const ledger = store.createUpdateLedger();
  assert.equal('database' in ledger, false);
  assert.equal('transaction' in ledger, false);
  assert.equal('withTransaction' in ledger, false);
  assert.equal(JSON.stringify(store.getStatus()).includes(stateDir), false);
  store.close();
  assert.deepEqual(store.getStatus(), {
    open: false,
    healthy: false,
    schemaVersion: null,
    journalMode: null,
  });
});

test('hostile content getters fail with a sanitized history error', (t) => {
  const { store } = fixture(t);
  const scope = store.getOrCreateScope({ chatId: '105' });
  const secret = 'GETTER-SECRET-445566';
  const content = {};
  Object.defineProperty(content, 'kind', {
    enumerable: true,
    get() { throw new Error(secret); },
  });

  assert.throws(
    () => store.appendTurn({
      scopeKey: scope.key,
      turnId: 'hostile-getter',
      messages: [{ role: 'user', content }],
    }),
    (error) => {
      assert.equal(error.code, 'HISTORY_INVALID');
      assert.equal(`${error.message}\n${error.stack}`.includes(secret), false);
      return true;
    },
  );
  assert.deepEqual(store.getHistory(scope.key), []);
});

test('close failure retains an open handle and a later close can retry safely', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-close-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  let attempts = 0;
  function RetryCloseDatabase(filename, options) {
    const db = new Database(filename, options);
    const realClose = db.close.bind(db);
    db.close = () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture close failure');
      return realClose();
    };
    return db;
  }
  const store = createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    DatabaseImpl: RetryCloseDatabase,
  });
  store.open();
  t.after(() => {
    try { store.close(); } catch { /* retry is asserted below */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => store.close(),
    (error) => error.code === 'STATE_CLOSE_FAILED' && !error.message.includes('fixture'),
  );
  assert.equal(store.getStatus().open, true);
  assert.doesNotThrow(() => store.getOrCreateScope({ chatId: '400' }));
  assert.doesNotThrow(() => store.close());
  assert.equal(store.getStatus().open, false);
  assert.equal(attempts, 2);
});
