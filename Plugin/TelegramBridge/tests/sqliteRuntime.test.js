'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {getSqliteDatabase,selectSqlite}=require('../src/sqliteRuntime');
test('uses working plugin SQLite when native ABI matches',()=>{
 assert.equal(typeof selectSqlite,'function');let fallback=0;class Working{close(){}}
 assert.equal(selectSqlite(()=>Working,()=>{fallback++;return Working;}),Working);assert.equal(fallback,0);
});
test('uses installed VCP runtime if plugin ships a foreign-platform native module',()=>{
 assert.equal(typeof selectSqlite,'function');class Foreign{constructor(){const e=new Error('not a valid Win32 application');e.code='ERR_DLOPEN_FAILED';throw e;}}class Working{close(){}}
 assert.equal(selectSqlite(()=>Foreign,()=>Working),Working);
});
test('does not hide unrelated database errors behind fallback',()=>{
 assert.equal(typeof selectSqlite,'function');let fallback=0;class Bad{constructor(){throw new Error('unexpected implementation error');}}
 assert.throws(()=>selectSqlite(()=>Bad,()=>{fallback++;}),/unexpected implementation error/);assert.equal(fallback,0);
});

const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const vm=require('node:vm');const {createRequire}=require('node:module');

// Execute the actual helper with isolated module loaders; never alter require.cache
// or the installed native packages to simulate a different host installation.
function loadRuntimeFixture({
  localError,
  localVersion = '12.9.0',
  projectVersion = '12.9.0',
  localName = 'better-sqlite3',
  projectName = 'better-sqlite3',
  projectRootName = 'vcptoolbox',
  requiredVersion = require('../package.json').dependencies['better-sqlite3'],
  outsideProjectEntry = false,
} = {}) {
  const filename = path.resolve(__dirname, '../src/sqliteRuntime.js');
  const projectManifest = path.resolve(path.dirname(filename), '../../../package.json');
  const events = [];
  class Local {
    constructor(filename) {
      events.push(['local:probe', filename]);
      if (localError) throw localError;
    }
    close() { events.push(['local:close']); }
  }
  class Project {
    constructor(filename) { events.push(['project:probe', filename]); }
    close() { events.push(['project:close']); }
  }
  function loader(label, root, Database, name, version) {
    const packageRoot = path.join(root, 'node_modules/better-sqlite3');
    const manifest = path.join(packageRoot, 'package.json');
    const entry = label === 'project' && outsideProjectEntry
      ? path.join(root, 'node_modules/better-sqlite3-impostor/index.js')
      : path.join(packageRoot, 'lib/index.js');
    function load(request) {
      if (request === 'better-sqlite3' || request === entry) {
        events.push([`${label}:runtime`]);
        return Database;
      }
      if (request === 'better-sqlite3/package.json' || request === manifest) {
        return { name, version, main: 'lib/index.js' };
      }
      if (request === '../package.json') {
        return { name: 'vcp-telegram-bridge', dependencies: { 'better-sqlite3': requiredVersion } };
      }
      if (request === projectManifest) return { name: projectRootName };
      if (request === 'node:path') return path;
      if (request === 'node:fs') return { realpathSync: (value) => value };
      if (request === 'node:module') {
        return { createRequire: (anchor) => {
          assert.equal(anchor, projectManifest);
          events.push(['project:loader']);
          return projectRequire;
        } };
      }
      throw new Error(`Unexpected fixture import: ${request}`);
    }
    load.resolve = (request) => {
      if (request === 'better-sqlite3/package.json') return manifest;
      if (request === 'better-sqlite3') return entry;
      throw new Error(`Unexpected fixture resolution: ${request}`);
    };
    return load;
  }
  const projectRequire = loader('project', path.dirname(projectManifest), Project, projectName, projectVersion);
  const localRequire = loader('local', path.resolve(__dirname, '..'), Local, localName, localVersion);
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  const load = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${source}\n})`, { filename });
  load(localRequire, module, module.exports, path.dirname(filename), filename);
  return { ...module.exports, Local, Project, events };
}

function nativeLoadError() {
  return Object.assign(new Error('not a valid Win32 application'), { code: 'ERR_DLOPEN_FAILED' });
}

test('actual getSqliteDatabase keeps working local 12.9.0 and caches its closed memory probe', () => {
  const fixture = loadRuntimeFixture({ projectVersion: '12.4.1' });
  assert.equal(fixture.getSqliteDatabase(), fixture.Local);
  assert.equal(fixture.getSqliteDatabase(), fixture.Local);
  assert.deepEqual(fixture.events, [['local:runtime'], ['local:probe', ':memory:'], ['local:close']]);
});

test('actual getSqliteDatabase rejects project 12.4.1 before loading its runtime', () => {
  const fixture = loadRuntimeFixture({ localError: nativeLoadError(), projectVersion: '12.4.1' });
  assert.throws(() => fixture.getSqliteDatabase(), (error) => {
    assert.equal(error.code, 'SQLITE_RUNTIME_VERSION_MISMATCH');
    assert.match(error.message, /12\.9\.0/);
    assert.match(error.message, /12\.4\.1/);
    return true;
  });
  assert.equal(fixture.events.some(([event]) => event === 'project:runtime'), false);
});

test('actual getSqliteDatabase accepts same-version project native runtime and caches it', () => {
  const fixture = loadRuntimeFixture({ localError: nativeLoadError() });
  assert.equal(fixture.getSqliteDatabase(), fixture.Project);
  assert.equal(fixture.getSqliteDatabase(), fixture.Project);
  assert.deepEqual(fixture.events, [
    ['local:runtime'], ['local:probe', ':memory:'], ['project:loader'],
    ['project:runtime'], ['project:probe', ':memory:'], ['project:close'],
  ]);
});

test('actual getSqliteDatabase rejects a wrong-version package inherited by local resolution', () => {
  const fixture = loadRuntimeFixture({ localVersion: '12.4.1' });
  assert.throws(() => fixture.getSqliteDatabase(), { code: 'SQLITE_RUNTIME_VERSION_MISMATCH' });
  assert.deepEqual(fixture.events, []);
});

for (const location of ['local', 'project']) {
  test(`actual getSqliteDatabase validates the ${location} source package name`, () => {
    const fixture = loadRuntimeFixture({
      [`${location}Name`]: 'unrelated-sqlite-package',
      localError: location === 'project' ? nativeLoadError() : undefined,
    });
    assert.throws(() => fixture.getSqliteDatabase(), { code: 'SQLITE_RUNTIME_PACKAGE_INVALID' });
    assert.equal(fixture.events.some(([event]) => event === `${location}:runtime`), false);
  });
}

test('actual getSqliteDatabase rejects a runtime entry outside the validated source package', () => {
  const fixture = loadRuntimeFixture({ localError: nativeLoadError(), outsideProjectEntry: true });
  assert.throws(() => fixture.getSqliteDatabase(), { code: 'SQLITE_RUNTIME_PACKAGE_INVALID' });
  assert.equal(fixture.events.some(([event]) => event === 'project:runtime'), false);
});

test('actual getSqliteDatabase validates the project root before using its runtime', () => {
  const fixture = loadRuntimeFixture({ localError: nativeLoadError(), projectRootName: 'unrelated-host' });
  assert.throws(() => fixture.getSqliteDatabase(), { code: 'SQLITE_RUNTIME_PROJECT_INVALID' });
  assert.equal(fixture.events.some(([event]) => event === 'project:runtime'), false);
});

test('actual getSqliteDatabase requires an exact plugin dependency pin', () => {
  const fixture = loadRuntimeFixture({ requiredVersion: '^12.9.0' });
  assert.throws(() => fixture.getSqliteDatabase(), { code: 'SQLITE_RUNTIME_VERSION_MISMATCH' });
  assert.deepEqual(fixture.events, []);
});

test('actual getSqliteDatabase propagates SQLITE errors even when their messages mention native bindings', () => {
  const error = Object.assign(new Error('Could not locate the bindings file'), { code: 'SQLITE_ERROR' });
  const fixture = loadRuntimeFixture({ localError: error });
  assert.throws(() => fixture.getSqliteDatabase(), (actual) => actual === error);
  assert.equal(fixture.events.some(([event]) => event.startsWith('project:')), false);
});

test('selectSqlite does not treat a missing unrelated JavaScript dependency as native unavailability', () => {
  const error = Object.assign(new Error("Cannot find module 'unrelated-dependency'"), { code: 'MODULE_NOT_FOUND' });
  let fallback = 0;
  class Working { close() {} }
  assert.throws(() => selectSqlite(() => { throw error; }, () => { fallback++; return Working; }),
    (actual) => actual === error);
  assert.equal(fallback, 0);
});

test('selectSqlite can fall back when the local better-sqlite3 package is absent', () => {
  const error = Object.assign(new Error("Cannot find module 'better-sqlite3/package.json'"), { code: 'MODULE_NOT_FOUND' });
  let closed = 0;
  class Working {
    constructor(filename) { assert.equal(filename, ':memory:'); }
    close() { closed++; }
  }
  assert.equal(selectSqlite(() => { throw error; }, () => Working), Working);
  assert.equal(closed, 1);
});

for (const location of ['local', 'project']) {
  test(`selectSqlite retries cleanup after ${location} probe close fails and preserves the original error`, () => {
    const error = nativeLoadError();
    let closed = 0;
    let fallback = 0;
    class Probe {
      constructor() { this.open = true; }
      close() {
        closed++;
        if (closed === 1) throw error;
        this.open = false;
      }
    }
    assert.throws(() => selectSqlite(
      () => { if (location === 'project') throw nativeLoadError(); return Probe; },
      () => { fallback++; return Probe; },
    ), (actual) => actual === error);
    assert.equal(closed, 2);
    assert.equal(fallback, location === 'project' ? 1 : 0);
  });
}

test('actual getSqliteDatabase executes a normal in-memory query with installed local 12.9.0', () => {
  assert.equal(require('../package.json').dependencies['better-sqlite3'], '12.9.0');
  assert.equal(require('better-sqlite3/package.json').version, '12.9.0');
  const Database = getSqliteDatabase();
  assert.equal(Database, require('better-sqlite3'));
  const database = new Database(':memory:');
  try {
    assert.deepEqual(database.prepare('SELECT 1 AS value').get(), { value: 1 });
  } finally {
    database.close();
  }
  assert.equal(database.open, false);
});

function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'tg-sqlite-source-'));t.after(()=>{assert.equal(path.dirname(fs.realpathSync.native(root)),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return root;}

test('actual sessionStore opens migrated state with the installed compatible SQLite runtime',t=>{
 const root=temporary(t);const {createSessionStore}=require('../src/sessionStore');
 const store=createSessionStore({pluginRoot:root,stateDir:path.join(root,'state'),defaultAgent:'ExampleAgent',historyMaxMessages:40,historyMaxBytes:262144});
 try {store.open();assert.equal(store.getStatus().healthy,true);} finally {store.close();}
});

test('actual TelegramBridge openState uses compatible SQLite and never calls a direct native require',t=>{
 const root=temporary(t);const filename=path.resolve(__dirname,'../TelegramBridge.js');const realRequire=createRequire(filename);
 const module={exports:{}};let selections=0;
 const source=fs.readFileSync(filename,'utf8')+'\nmodule.exports.__createDefaultRuntime=createDefaultRuntime;';
 const load=vm.runInThisContext('(function(require,module,exports,__dirname,__filename){'+source+'\n})',{filename});
 load(name=>{if(name==='better-sqlite3')throw new Error('Direct native require bypassed compatibility selection');if(name==='./src/sqliteRuntime'){const helper=realRequire(name);return {getSqliteDatabase:()=>{selections++;return helper.getSqliteDatabase();}};}return realRequire(name);},module,module.exports,path.join(root,'Plugin','TelegramBridge'),filename);
 const {parseConfig}=realRequire('./src/config');const config=parseConfig({TELEGRAM_MODE:'probe',TELEGRAM_BOT_TOKEN:'123456:fixture_abcdefghijklmnopqrstuvwxyz',TELEGRAM_ALLOWED_USER_IDS:'12345',TELEGRAM_VCP_KEY:'fixture-vcp-key'},{projectBasePath:root});
 const runtime=module.exports.__createDefaultRuntime(config,{fetchImpl:async()=>{throw new Error('No network allowed in source-load test');}},root);
 try {runtime.ensureDirectories();runtime.openState();assert.equal(runtime.snapshot().database.healthy,true);assert.equal(selections,1);} finally {runtime.close();}
});
