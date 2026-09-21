const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const entryPointPath = path.join(pluginRoot, 'TelegramBridge.js');
const isolationRunnerPath = path.join(__dirname, 'helpers', 'bootstrap-isolation-runner.js');
const expectedMessage = 'Invalid TelegramBridge configuration.';

async function captureInitializeError(plugin, config) {
  try {
    await plugin.initialize(config, {});
  } catch (error) {
    return error;
  }

  assert.fail('initialize should reject a non-disabled or invalid mode');
}

test('invalid configuration throws stable sanitized ConfigError data', async () => {
  delete require.cache[require.resolve(entryPointPath)];
  const plugin = require(entryPointPath);
  const cases = [
    {
      config: { TELEGRAM_MODE: 'UNTRUSTED_MODE_MARKER' },
      marker: 'UNTRUSTED_MODE_MARKER',
      field: 'TELEGRAM_MODE',
    },
    { config: { TELEGRAM_MODE: 17 }, marker: '17', field: 'TELEGRAM_MODE' },
    {
      config: {
        TELEGRAM_MODE: {
          toString() {
            return 'UNTRUSTED_OBJECT_MARKER';
          },
        },
      },
      marker: 'UNTRUSTED_OBJECT_MARKER',
      field: 'TELEGRAM_MODE',
    },
    {
      config: new Proxy({}, {
        ownKeys() {
          throw new Error('UNTRUSTED_GETTER_MARKER');
        },
      }),
      marker: 'UNTRUSTED_GETTER_MARKER',
      field: 'CONFIG',
    },
  ];

  for (const { config, marker, field } of cases) {
    const error = await captureInitializeError(plugin, config);
    const enumerableFields = JSON.stringify(Object.fromEntries(Object.entries(error)));

    assert.equal(error.code, 'CONFIG_INVALID');
    assert.equal(error.field, field);
    assert.equal(error.message, expectedMessage);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'field']);
    assert.equal(error.message.includes(marker), false);
    assert.equal(enumerableFields.includes(marker), false);
  }

  await plugin.shutdown();
});

test('unspecified NODE_ENV fails closed as production for content logging', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  delete require.cache[require.resolve(entryPointPath)];
  const plugin = require(entryPointPath);

  try {
    await assert.rejects(
      plugin.initialize({
        TELEGRAM_MODE: 'disabled',
        TELEGRAM_LOG_CONTENT: 'true',
      }, {}),
      (error) => error?.code === 'CONFIG_FORBIDDEN'
        && error?.field === 'TELEGRAM_LOG_CONTENT',
    );
  } finally {
    await plugin.shutdown();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('module load and disabled lifecycle are side-effect free in an isolated process', () => {
  const result = spawnSync(
    process.execPath,
    [isolationRunnerPath, entryPointPath],
    {
      cwd: pluginRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
