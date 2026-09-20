'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { createSessionStore } = require('../src/sessionStore');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-path-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  fs.mkdirSync(pluginRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, pluginRoot };
}

function create(pluginRoot, stateDir) {
  return createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
}

function assertPathRejected(action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, 'STATE_PATH_INVALID');
    assert.equal(error.message.includes(os.tmpdir()), false);
    return true;
  });
}

function tryHardLink(source, target) {
  try {
    fs.linkSync(source, target);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'EXDEV', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
}

test('state directory must be a physical descendant and not the plugin root', (t) => {
  const { root, pluginRoot } = fixture(t);

  for (const stateDir of [
    pluginRoot,
    path.join(pluginRoot, '.'),
    path.resolve(pluginRoot, '..', 'outside'),
    path.join(root, 'TelegramBridge-sibling', 'state'),
    path.join(pluginRoot, '..', 'escape'),
  ]) {
    assertPathRejected(() => create(pluginRoot, stateDir).open());
  }

  assert.equal(fs.existsSync(path.join(root, 'outside')), false);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  assert.equal(fs.existsSync(path.join(root, 'TelegramBridge-sibling')), false);
});

test('nearest existing ancestor symlink or junction cannot escape plugin root', (t) => {
  const { root, pluginRoot } = fixture(t);
  const outside = path.join(root, 'outside');
  const link = path.join(pluginRoot, 'linked');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('directory links are unavailable on this host');
      return;
    }
    throw error;
  }

  assertPathRejected(() => create(pluginRoot, path.join(link, 'state')).open());
  assert.equal(fs.existsSync(path.join(outside, 'state')), false);
});

test('existing database file symlink cannot redirect persistence', (t) => {
  const { root, pluginRoot } = fixture(t);
  const stateDir = path.join(pluginRoot, 'state');
  const outsideDatabase = path.join(root, 'outside.sqlite3');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(outsideDatabase, 'fixture');
  try {
    fs.symlinkSync(outsideDatabase, path.join(stateDir, 'telegram.sqlite3'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('file links are unavailable on this host');
      return;
    }
    throw error;
  }

  assertPathRejected(() => create(pluginRoot, stateDir).open());
  assert.equal(fs.readFileSync(outsideDatabase, 'utf8'), 'fixture');
});

test('dangling database file symlink cannot create an outside target', (t) => {
  const { root, pluginRoot } = fixture(t);
  const stateDir = path.join(pluginRoot, 'state');
  const outsideDatabase = path.join(root, 'outside-new.sqlite3');
  fs.mkdirSync(stateDir);
  try {
    fs.symlinkSync(outsideDatabase, path.join(stateDir, 'telegram.sqlite3'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('file links are unavailable on this host');
      return;
    }
    throw error;
  }

  assertPathRejected(() => create(pluginRoot, stateDir).open());
  assert.equal(fs.existsSync(outsideDatabase), false);
});

test('database sidecar symlinks are rejected before SQLite opens', (t) => {
  const { root, pluginRoot } = fixture(t);
  const outside = path.join(root, 'outside-sidecar');
  fs.mkdirSync(outside);
  let tested = 0;
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const stateDir = path.join(pluginRoot, `state-${suffix.slice(1)}`);
    fs.mkdirSync(stateDir);
    const link = path.join(stateDir, `telegram.sqlite3${suffix}`);
    try {
      fs.symlinkSync(path.join(outside, `target${suffix}`), link, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) continue;
      throw error;
    }
    tested += 1;
    assertPathRejected(() => create(pluginRoot, stateDir).open());
  }
  if (tested === 0) t.skip('file links are unavailable on this host');
});

test('a pre-existing main database hard link is rejected without deleting either name', (t) => {
  const { root, pluginRoot } = fixture(t);
  const stateDir = path.join(pluginRoot, 'hard-main');
  const databasePath = path.join(stateDir, 'telegram.sqlite3');
  const outsidePath = path.join(root, 'outside-main.sqlite3');
  fs.mkdirSync(stateDir);
  const outside = new Database(outsidePath);
  outside.close();
  if (!tryHardLink(outsidePath, databasePath)) {
    t.skip('hard links are unavailable on this filesystem');
    return;
  }
  const store = create(pluginRoot, stateDir);
  t.after(() => {
    try { store.close(); } catch { /* expected only on broken implementations */ }
  });

  assertPathRejected(() => store.open());
  assert.equal(fs.existsSync(outsidePath), true);
  assert.equal(fs.existsSync(databasePath), true);
  assert.ok(fs.lstatSync(outsidePath).nlink > 1);
  assert.ok(fs.lstatSync(databasePath).nlink > 1);
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`a pre-existing ${suffix} hard link is rejected without deletion`, (t) => {
    const { root, pluginRoot } = fixture(t);
    const stateDir = path.join(pluginRoot, `hard-pre-${suffix.slice(1)}`);
    const databasePath = path.join(stateDir, 'telegram.sqlite3');
    const sidecarPath = `${databasePath}${suffix}`;
    const outsidePath = path.join(root, `outside-pre${suffix}`);
    fs.mkdirSync(stateDir);
    const main = new Database(databasePath);
    main.close();
    fs.writeFileSync(outsidePath, 'hard-link-fixture', 'utf8');
    if (!tryHardLink(outsidePath, sidecarPath)) {
      t.skip('hard links are unavailable on this filesystem');
      return;
    }
    const store = create(pluginRoot, stateDir);
    t.after(() => {
      try { store.close(); } catch { /* expected only on broken implementations */ }
    });

    assertPathRejected(() => store.open());
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(sidecarPath), true);
    assert.ok(fs.lstatSync(outsidePath).nlink > 1);
    assert.ok(fs.lstatSync(sidecarPath).nlink > 1);
  });
}

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  test(`post-open revalidation rejects a new ${suffix || 'main'} hard link`, (t) => {
    const { root, pluginRoot } = fixture(t);
    const probeSource = path.join(root, `hard-link-probe-source-${suffix || 'main'}`);
    const probeTarget = path.join(root, `hard-link-probe-target-${suffix || 'main'}`);
    fs.writeFileSync(probeSource, 'probe', 'utf8');
    if (!tryHardLink(probeSource, probeTarget)) {
      t.skip('hard links are unavailable on this filesystem');
      return;
    }
    fs.rmSync(probeTarget, { force: true });
    fs.rmSync(probeSource, { force: true });
    const stateDir = path.join(pluginRoot, `hard-post-${suffix || 'main'}`);
    const outsidePath = path.join(root, `outside-post-${suffix || 'main'}`);
    let linkedPath;
    function LinkingDatabase(filename, options) {
      const db = new Database(filename, options);
      if (suffix === '') {
        if (!tryHardLink(filename, outsidePath)) {
          db.close();
          return db;
        }
        linkedPath = filename;
      } else {
        const candidate = `${filename}${suffix}`;
        fs.writeFileSync(outsidePath, 'hard-link-fixture', 'utf8');
        if (!tryHardLink(outsidePath, candidate)) {
          db.close();
          return db;
        }
        linkedPath = candidate;
      }
      return db;
    }
    const store = createSessionStore({
      pluginRoot,
      stateDir,
      defaultAgent: 'ExampleAgent',
      historyMaxMessages: 40,
      historyMaxBytes: 262144,
      DatabaseImpl: LinkingDatabase,
    });
    t.after(() => {
      try { store.close(); } catch { /* expected only on broken implementations */ }
    });

    assertPathRejected(() => store.open());
    assert.equal(fs.existsSync(outsidePath), true);
    assert.equal(fs.existsSync(linkedPath), true);
    assert.ok(fs.lstatSync(outsidePath).nlink > 1);
    assert.ok(fs.lstatSync(linkedPath).nlink > 1);
  });
}

test('abnormal main database and sidecar filesystem objects are rejected', (t) => {
  const { pluginRoot } = fixture(t);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stateDir = path.join(pluginRoot, `abnormal-${suffix || 'main'}`);
    fs.mkdirSync(stateDir);
    fs.mkdirSync(path.join(stateDir, `telegram.sqlite3${suffix}`));
    assertPathRejected(() => create(pluginRoot, stateDir).open());
  }
});

test('post-open physical path revalidation catches a swapped state directory', (t) => {
  const { root, pluginRoot } = fixture(t);
  const stateDir = path.join(pluginRoot, 'state-swap');
  const outside = path.join(root, 'outside-swap');
  fs.mkdirSync(outside);
  let databaseTouched = false;
  function SwappingDatabase() {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.symlinkSync(outside, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
    return {
      open: true,
      close() { this.open = false; },
      pragma() { databaseTouched = true; throw new Error('must not configure'); },
      prepare() { databaseTouched = true; throw new Error('must not inspect'); },
    };
  }
  const store = createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
    DatabaseImpl: SwappingDatabase,
  });

  assertPathRejected(() => store.open());
  assert.equal(databaseTouched, false);
});

test('state database and existing WAL sidecars use private POSIX modes', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not enforced on Windows');
    return;
  }
  const { pluginRoot } = fixture(t);
  const stateDir = path.join(pluginRoot, 'private-state');
  const store = create(pluginRoot, stateDir);
  store.open();
  try {
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const candidate = path.join(stateDir, `telegram.sqlite3${suffix}`);
      if (fs.existsSync(candidate)) assert.equal(fs.statSync(candidate).mode & 0o777, 0o600);
    }
  } finally {
    store.close();
  }
});

test('valid nested state opens and Windows path case remains contained', (t) => {
  const { pluginRoot } = fixture(t);
  const rootArgument = process.platform === 'win32'
    ? `${pluginRoot[0].toLowerCase()}${pluginRoot.slice(1)}`
    : pluginRoot;
  const store = create(rootArgument, path.join(rootArgument, 'state', 'nested'));
  store.open();
  assert.equal(store.getStatus().open, true);
  store.close();
});
