const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(pluginRoot, 'plugin-manifest.json');
const entryPointPath = path.join(pluginRoot, 'TelegramBridge.js');
const packagePath = path.join(pluginRoot, 'package.json');
const packageLockPath = path.join(pluginRoot, 'package-lock.json');
const manifestExists = fs.existsSync(manifestPath);
const configExamplePath = path.join(pluginRoot, 'config.env.example');

const telegramConfigKeys = Object.freeze([
  'TELEGRAM_MODE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_GROUPS_ENABLED',
  'TELEGRAM_DEFAULT_AGENT',
  'TELEGRAM_ALLOWED_AGENTS',
  'TELEGRAM_POLL_TIMEOUT_SEC',
  'TELEGRAM_UPDATE_LIMIT',
  'TELEGRAM_MAX_CONCURRENT_SCOPES',
  'TELEGRAM_MAX_QUEUED_TOTAL',
  'TELEGRAM_MAX_QUEUED_PER_SCOPE',
  'TELEGRAM_MAX_INBOUND_BYTES',
  'TELEGRAM_MAX_OUTBOUND_BYTES',
  'TELEGRAM_OUTBOUND_DNS',
  'TELEGRAM_HISTORY_MAX_MESSAGES',
  'TELEGRAM_HISTORY_MAX_BYTES',
  'TELEGRAM_STATE_DIR',
  'TELEGRAM_VCP_BASE_URL',
  'TELEGRAM_VCP_MODEL',
  'TELEGRAM_AGENT_MODELS',
  'TELEGRAM_VCP_TEMPERATURE',
  'TELEGRAM_VCP_MAX_TOKENS',
  'TELEGRAM_VCP_KEY',
  'TELEGRAM_STREAM_MODE',
  'TELEGRAM_PROACTIVE_ENABLED',
  'TELEGRAM_LOG_CONTENT',
]);

test('active manifest exists and declares the TelegramBridge runtime contract', () => {
  assert.equal(
    manifestExists,
    true,
    'plugin-manifest.json does not exist',
  );

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifestVersion, '1.0');
  assert.equal(manifest.version, '0.1.0-beta.1');
  assert.equal(manifest.name, 'TelegramBridge');
  assert.equal(manifest.pluginType, 'hybridservice');
  assert.equal(typeof manifest.displayName, 'string');
  assert.ok(manifest.displayName.length > 0);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
  assert.deepEqual(manifest.entryPoint, {
    type: 'nodejs',
    script: 'TelegramBridge.js',
  });
  assert.equal(manifest.communication?.protocol, 'direct');
  assert.equal('capabilities' in manifest, false);

  const modeSchema = manifest.configSchema?.TELEGRAM_MODE;
  assert.equal(modeSchema?.type, 'string');
  assert.equal(modeSchema?.default, 'disabled');
  assert.equal(modeSchema?.required, false);
  assert.deepEqual(modeSchema?.enum, ['disabled', 'probe', 'enabled']);
  assert.match(modeSchema?.description ?? '', /accepted modes/i);
  assert.match(modeSchema?.description ?? '', /\bprobe\b/i);
  assert.match(modeSchema?.description ?? '', /enabled/i);

  assert.deepEqual(Object.keys(manifest.configSchema).sort(), [...telegramConfigKeys].sort());
  for (const key of telegramConfigKeys) {
    assert.equal(manifest.configSchema[key]?.type, 'string', `${key} must stay a string`);
    assert.equal(manifest.configSchema[key]?.required, false);
  }
  assert.deepEqual(manifest.configSchema.TELEGRAM_MODE.enum, ['disabled', 'probe', 'enabled']);
  assert.equal(manifest.configSchema.TELEGRAM_MAX_QUEUED_TOTAL.default, '100');
  assert.equal(manifest.configSchema.TELEGRAM_MAX_QUEUED_PER_SCOPE.default, '20');
  assert.equal(manifest.configSchema.TELEGRAM_VCP_MODEL.default, 'VCPModelAuto');
  assert.equal(manifest.configSchema.TELEGRAM_OUTBOUND_DNS.default, 'system');
  assert.deepEqual(manifest.configSchema.TELEGRAM_OUTBOUND_DNS.enum, ['system', 'cloudflare']);

  const exampleKeys = fs.readFileSync(configExamplePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')));
  assert.deepEqual(
    exampleKeys.sort(),
    [...telegramConfigKeys].sort(),
  );
});

test('direct communication declares a nested timeout and no top-level timeout', {
  skip: !manifestExists,
}, () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(Number.isFinite(manifest.communication?.timeout), true);
  assert.ok(manifest.communication.timeout > 0);
  assert.equal('timeout' in manifest, false);
});

test('CommonJS entry point exports the fail-closed Task 2 lifecycle surface', {
  skip: !manifestExists,
}, () => {
  assert.equal(fs.existsSync(entryPointPath), true);

  delete require.cache[require.resolve(entryPointPath)];
  const plugin = require(entryPointPath);

  assert.equal(typeof plugin.initialize, 'function');
  assert.equal(plugin.initialize.constructor.name, 'AsyncFunction');
  assert.equal(typeof plugin.shutdown, 'function');
  assert.equal(plugin.shutdown.constructor.name, 'AsyncFunction');
  assert.equal(typeof plugin.processToolCall, 'function');
  assert.equal(plugin.processToolCall.constructor.name, 'AsyncFunction');
  assert.equal('processMessages' in plugin, false);
  assert.deepEqual(Object.keys(plugin).sort(), ['initialize', 'processToolCall', 'shutdown']);
});

test('disabled initialization remains side-effect-free', {
  skip: !manifestExists,
}, async () => {
  delete require.cache[require.resolve(entryPointPath)];
  const plugin = require(entryPointPath);
  const fixtureProjectBase = path.resolve(pluginRoot, '..', '..');

  const touched = [];
  const dependencies = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error('dependency access is forbidden in Task 2');
    },
  });

  await plugin.initialize({
    TELEGRAM_MODE: 'disabled',
    PROJECT_BASE_PATH: fixtureProjectBase,
  }, dependencies);
  assert.deepEqual(touched, []);
  await assert.rejects(
    plugin.processToolCall({}),
    (error) => error.code === 'BRIDGE_NOT_READY' && error.message === 'TelegramBridge is not ready.',
  );

  await plugin.shutdown();
  await plugin.shutdown();
});

test('package contract pins the runtime and native database dependency', {
  skip: !manifestExists,
}, () => {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  const supportedNodeVersions = '>=20.20.2 <21 || >=22.21.1 <23';

  assert.equal(packageJson.type, 'commonjs');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.engines?.node, supportedNodeVersions);
  assert.equal(packageLock.packages?.['']?.engines?.node, supportedNodeVersions);
  assert.equal(packageJson.dependencies?.['better-sqlite3'], '12.9.0');
  assert.equal(packageJson.scripts?.test, 'node --test tests/*.test.js');
  assert.match(packageJson.scripts?.check ?? '', /node --check TelegramBridge\.js/);
  assert.match(packageJson.scripts?.check ?? '', /node --check scripts\/package-release\.js/);
  assert.match(packageJson.scripts?.check ?? '', /node --check scripts\/scan-secrets\.js/);
  assert.equal(packageJson.scripts?.['scan:secrets'], 'node scripts/scan-secrets.js');
});
