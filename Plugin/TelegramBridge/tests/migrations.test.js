'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { loadMigrations, runMigrations } = require('../src/migrationRunner');
const { createSessionStore } = require('../src/sessionStore');

const EXPECTED_TABLES = [
  'approvals',
  'async_tasks',
  'attachments',
  'conversation_inputs',
  'dead_letters',
  'deliveries',
  'messages',
  'requests',
  'schema_migrations',
  'scopes',
  'updates',
];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-state-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  fs.mkdirSync(pluginRoot);
  return { root, pluginRoot, stateDir: path.join(pluginRoot, 'state') };
}

function makeStore(t, options = {}) {
  const paths = makeRoot();
  let captured;
  function CapturingDatabase(filename, databaseOptions) {
    captured = new Database(filename, databaseOptions);
    return captured;
  }
  const store = createSessionStore({
    ...paths,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    DatabaseImpl: CapturingDatabase,
    ...options,
  });
  t.after(() => {
    store.close();
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
  return { store, paths, getDatabase: () => captured };
}

function writeMigration(directory, filename, sql) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), sql, 'utf8');
}

function assertStableError(error, code) {
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.equal(error.message.includes('CREATE TABLE'), false);
  assert.equal(error.message.includes(os.tmpdir()), false);
  return true;
}

test('fresh open creates exactly the versioned STRICT schema and required PRAGMAs', (t) => {
  const { store, getDatabase } = makeStore(t);
  store.open();
  const db = getDatabase();

  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);

  assert.deepEqual(tables, EXPECTED_TABLES);
  const strictTables = db.prepare(`
    SELECT name, strict FROM pragma_table_list
    WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  assert.deepEqual(strictTables.map((row) => row.name), EXPECTED_TABLES);
  assert.equal(strictTables.every((row) => row.strict === 1), true);

  const identifierColumns = {
    scopes: ['scope_key', 'chat_id', 'thread_id', 'conversation_id'],
    messages: ['message_id', 'scope_key', 'conversation_id', 'turn_id', 'telegram_message_id'],
    updates: [
      'update_id', 'next_offset', 'scope_key', 'ordering_key', 'initial_request_id',
      'album_parent_update_id',
      'input_bundle_key',
    ],
    requests: [
      'request_id', 'message_id', 'update_id', 'scope_key', 'ordering_key',
      'retry_of_request_id', 'worker_id', 'owner_user_id',
    ],
    approvals: ['approval_id', 'request_id', 'owner_user_id'],
    attachments: [
      'attachment_id', 'scope_key', 'request_id', 'telegram_message_id',
      'telegram_file_id', 'telegram_file_unique_id',
    ],
    conversation_inputs: ['request_id','scope_key','conversation_id','owner_user_id','telegram_message_id'],
    async_tasks: ['task_key', 'task_id', 'request_id', 'scope_key'],
    deliveries: ['idempotency_key', 'scope_key', 'source_key', 'telegram_message_id'],
    dead_letters: ['dead_letter_id', 'source_key', 'scope_key'],
  };
  for (const [table, columns] of Object.entries(identifierColumns)) {
    const types = new Map(db.prepare(`PRAGMA table_info(${table})`).all()
      .map((column) => [column.name, column.type]));
    for (const column of columns) assert.equal(types.get(column), 'TEXT', `${table}.${column}`);
  }

  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.deepEqual(db.prepare('PRAGMA quick_check(1)').all(), [{ quick_check: 'ok' }]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const migrations = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })), [
    { version: 1, name: '001_initial.sql' },
    { version: 2, name: '002_durable_update_ledger.sql' },
    { version: 3, name: '003_stream_delivery.sql' },
    { version: 4, name: '004_approval_broker.sql' },
    { version: 5, name: '005_rich_media_delivery.sql' },
    { version: 6, name: '006_album_members.sql' },
    { version: 7, name: '007_async_media.sql' },
    { version: 8, name: '008_input_context.sql' },
    { version: 9, name: '009_conversation_inputs.sql' },
  ]);
  assert.equal(migrations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)), true);

  assert.throws(
    () => db.prepare(`
      INSERT INTO messages (
        message_id, scope_key, conversation_id, turn_id, turn_seq,
        position, role, content_json, content_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('m1', 'missing', 'c1', 't1', 0, 0, 'user', '"x"', 3, 1),
    /FOREIGN KEY constraint failed/,
  );
});

test('closing and reopening is idempotent and recovers WAL state', (t) => {
  const paths = makeRoot();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  const first = createSessionStore({
    ...paths,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  first.open();
  first.getOrCreateScope({ chatId: '900719925474099312345' });
  first.close();
  first.close();

  const second = createSessionStore({
    ...paths,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  second.open();
  assert.equal(second.getOrCreateScope({ chatId: '900719925474099312345' }).chatId, '900719925474099312345');
  assert.equal(second.getStatus().schemaVersion, 9);
  second.close();
});

test('migration loader requires contiguous unique names and rejects transaction SQL', (t) => {
  const { root } = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const gap = path.join(root, 'gap');
  writeMigration(gap, '001_one.sql', 'CREATE TABLE one (id TEXT) STRICT;');
  writeMigration(gap, '003_three.sql', 'CREATE TABLE three (id TEXT) STRICT;');
  assert.throws(() => loadMigrations(gap), (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'));

  const malformed = path.join(root, 'malformed');
  writeMigration(malformed, '1_bad.sql', 'SELECT 1;');
  assert.throws(() => loadMigrations(malformed), (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'));

  const controlled = path.join(root, 'controlled');
  writeMigration(controlled, '001_bad.sql', 'BEGIN; CREATE TABLE bad (id TEXT); COMMIT;');
  assert.throws(() => loadMigrations(controlled), (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'));

  for (const [name, sql] of [
    ['end', 'CREATE TABLE escaped (id TEXT); END;'],
    ['end-transaction', 'CREATE TABLE escaped (id TEXT); END TRANSACTION;'],
  ]) {
    const directory = path.join(root, name);
    writeMigration(directory, '001_escape.sql', sql);
    assert.throws(
      () => loadMigrations(directory),
      (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'),
    );
  }
});

test('migration checksums are stable and changed applied migrations are rejected', (t) => {
  const { root } = makeRoot();
  const migrationsDir = path.join(root, 'migrations');
  writeMigration(migrationsDir, '001_one.sql', 'CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;');
  const db = new Database(path.join(root, 'test.sqlite3'));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  runMigrations(db, loadMigrations(migrationsDir), { now: () => 1 });
  runMigrations(db, loadMigrations(migrationsDir), { now: () => 2 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);

  fs.writeFileSync(
    path.join(migrationsDir, '001_one.sql'),
    'CREATE TABLE one (id TEXT PRIMARY KEY, changed TEXT) STRICT;',
    'utf8',
  );
  assert.throws(
    () => runMigrations(db, loadMigrations(migrationsDir), { now: () => 3 }),
    (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'),
  );
});

test('database schema newer than available migrations is rejected', (t) => {
  const { root } = makeRoot();
  const migrationsDir = path.join(root, 'migrations');
  writeMigration(migrationsDir, '001_one.sql', 'CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;');
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const descriptors = loadMigrations(migrationsDir);
  runMigrations(db, descriptors, { now: () => 1 });
  db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (2, ?, ?, ?)')
    .run('002_future.sql', '0'.repeat(64), 2);

  assert.throws(
    () => runMigrations(db, descriptors, { now: () => 3 }),
    (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'),
  );
});

test('a failing migration rolls back the whole batch', (t) => {
  const { root } = makeRoot();
  const migrationsDir = path.join(root, 'migrations');
  writeMigration(migrationsDir, '001_one.sql', 'CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;');
  writeMigration(migrationsDir, '002_bad.sql', 'CREATE TABL invalid syntax;');
  const db = new Database(':memory:');
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => runMigrations(db, loadMigrations(migrationsDir), { now: () => 1 }),
    (error) => assertStableError(error, 'STATE_MIGRATION_FAILED'),
  );
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();
  assert.deepEqual(tables, []);
});

test('a failing migration batch remains rolled back after persistent database reopen', (t) => {
  const { root } = makeRoot();
  const migrationsDir = path.join(root, 'migrations');
  const databasePath = path.join(root, 'persistent.sqlite3');
  writeMigration(migrationsDir, '001_one.sql', 'CREATE TABLE one (id TEXT PRIMARY KEY) STRICT;');
  writeMigration(migrationsDir, '002_bad.sql', 'CREATE TABL invalid syntax;');

  const first = new Database(databasePath);
  assert.throws(
    () => runMigrations(first, loadMigrations(migrationsDir), { now: () => 1 }),
    (error) => assertStableError(error, 'STATE_MIGRATION_FAILED'),
  );
  first.close();

  const reopened = new Database(databasePath);
  try {
    const tables = reopened.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all();
    assert.deepEqual(tables, []);
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMigrations cannot bypass END filtering and persist an escaped partial batch', (t) => {
  const { root } = makeRoot();
  const databasePath = path.join(root, 'escaped.sqlite3');
  const sql = 'CREATE TABLE escaped (id TEXT); END; CREATE TABL invalid syntax;';
  const descriptors = [{
    version: 1,
    name: '001_escape.sql',
    sql,
    checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex'),
  }];
  const first = new Database(databasePath);
  assert.throws(
    () => runMigrations(first, descriptors, { now: () => 1 }),
    (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'),
  );
  first.close();

  const reopened = new Database(databasePath);
  try {
    assert.deepEqual(reopened.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all(), []);
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runMigrations snapshots every descriptor field once before opening its transaction', (t) => {
  const { root } = makeRoot();
  const databasePath = path.join(root, 'snapshot.sqlite3');
  const safeSql = 'CREATE TABLE snapshot_safe (id TEXT PRIMARY KEY) STRICT;';
  const escapedSql = 'CREATE TABLE escaped (id TEXT); END; CREATE TABL invalid syntax;';
  const safeChecksum = crypto.createHash('sha256').update(safeSql, 'utf8').digest('hex');
  const reads = { version: 0, name: 0, sql: 0, checksum: 0 };
  const descriptor = {};
  Object.defineProperties(descriptor, {
    version: {
      enumerable: true,
      get() { reads.version += 1; return reads.version === 1 ? 1 : 2; },
    },
    name: {
      enumerable: true,
      get() { reads.name += 1; return reads.name === 1 ? '001_snapshot.sql' : '002_changed.sql'; },
    },
    sql: {
      enumerable: true,
      get() { reads.sql += 1; return reads.sql === 1 ? safeSql : escapedSql; },
    },
    checksum: {
      enumerable: true,
      get() { reads.checksum += 1; return reads.checksum === 1 ? safeChecksum : '0'.repeat(64); },
    },
  });

  const first = new Database(databasePath);
  let migrationError;
  try {
    runMigrations(first, [descriptor], { now: () => 1 });
  } catch (error) {
    migrationError = error;
  } finally {
    first.close();
  }

  const reopened = new Database(databasePath);
  try {
    assert.equal(migrationError, undefined);
    assert.deepEqual(reads, { version: 1, name: 1, sql: 1, checksum: 1 });
    assert.deepEqual(
      reopened.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => row.name),
      ['schema_migrations', 'snapshot_safe'],
    );
    assert.deepEqual(
      reopened.prepare('SELECT version, name, checksum FROM schema_migrations').get(),
      { version: 1, name: '001_snapshot.sql', checksum: safeChecksum },
    );
  } finally {
    reopened.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, descriptor] of [
  ['noncontiguous version', {
    version: 2,
    name: '002_wrong.sql',
    sql: 'CREATE TABLE wrong_version (id TEXT) STRICT;',
  }],
  ['malformed name', {
    version: 1,
    name: 'not-a-migration.sql',
    sql: 'CREATE TABLE wrong_name (id TEXT) STRICT;',
  }],
  ['checksum mismatch', {
    version: 1,
    name: '001_wrong_checksum.sql',
    sql: 'CREATE TABLE wrong_checksum (id TEXT) STRICT;',
    checksum: '0'.repeat(64),
  }],
]) {
  test(`runMigrations rejects descriptor ${label} before touching the database`, () => {
    const checksum = descriptor.checksum
      ?? crypto.createHash('sha256').update(descriptor.sql, 'utf8').digest('hex');
    const db = new Database(':memory:');
    try {
      assert.throws(
        () => runMigrations(db, [{ ...descriptor, checksum }], { now: () => 1 }),
        (error) => assertStableError(error, 'STATE_MIGRATION_INVALID'),
      );
      assert.deepEqual(db.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).all(), []);
    } finally {
      db.close();
    }
  });
}

test('migration SQL permits END in comments, strings, and CASE expressions', (t) => {
  const { root } = makeRoot();
  const migrationsDir = path.join(root, 'legitimate-end');
  writeMigration(migrationsDir, '001_legitimate_end.sql', `
    -- END TRANSACTION is inert inside this comment.
    CREATE TABLE legitimate_end (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT 'END TRANSACTION'
    ) STRICT;
    INSERT INTO legitimate_end (id, value)
    SELECT 'case', CASE WHEN 1 THEN 'accepted' ELSE 'rejected' END;
  `);
  const db = new Database(':memory:');
  try {
    const descriptors = loadMigrations(migrationsDir);
    runMigrations(db, descriptors, { now: () => 1 });
    assert.deepEqual(
      db.prepare('SELECT id, value FROM legitimate_end').get(),
      { id: 'case', value: 'accepted' },
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('store closes its database when migration execution fails', (t) => {
  const paths = makeRoot();
  t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
  let captured;
  function FailingDatabase(filename, options) {
    const db = new Database(filename, options);
    captured = db;
    const originalExec = db.exec.bind(db);
    db.exec = (sql) => {
      if (sql.includes('CREATE TABLE scopes')) throw new Error('fixture migration failure');
      return originalExec(sql);
    };
    return db;
  }
  const store = createSessionStore({
    ...paths,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    DatabaseImpl: FailingDatabase,
  });

  assert.throws(() => store.open(), (error) => assertStableError(error, 'STATE_MIGRATION_FAILED'));
  assert.equal(captured.open, false);
  assert.equal(store.getStatus().open, false);
});

function makeIntegrityDatabase(mode, capture) {
  return function IntegrityDatabase(filename, options) {
    const db = new Database(filename, options);
    capture(db);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const normalized = String(sql).trim().toLowerCase();
      if (mode === 'quick' && normalized.startsWith('pragma quick_check')) {
        return { all: () => [{ quick_check: 'fixture-corrupt' }] };
      }
      if (mode === 'foreign' && normalized.startsWith('pragma foreign_key_check')) {
        return { all: () => [{ table: 'fixture', rowid: 1, parent: 'fixture', fkid: 0 }] };
      }
      return originalPrepare(sql);
    };
    return db;
  };
}

for (const mode of ['quick', 'foreign']) {
  test(`${mode} integrity failure is sanitized and closes the database`, (t) => {
    const paths = makeRoot();
    t.after(() => fs.rmSync(paths.root, { recursive: true, force: true }));
    let captured;
    const store = createSessionStore({
      ...paths,
      defaultAgent: 'ExampleAgent',
      historyMaxMessages: 40,
      historyMaxBytes: 262144,
      DatabaseImpl: makeIntegrityDatabase(mode, (db) => { captured = db; }),
    });

    assert.throws(() => store.open(), (error) => assertStableError(error, 'STATE_INTEGRITY_FAILED'));
    assert.equal(captured.open, false);
    assert.deepEqual(store.getStatus(), {
      open: false,
      healthy: false,
      schemaVersion: null,
      journalMode: null,
    });
  });
}
