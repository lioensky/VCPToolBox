'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const pluginPath = path.resolve(__dirname, '..', 'TelegramBridge.js');

function loadPlugin() {
  delete require.cache[require.resolve(pluginPath)];
  return require(pluginPath);
}

function raw() {
  return {
    TELEGRAM_MODE: 'enabled', TELEGRAM_BOT_TOKEN: 'fixture-token',
    TELEGRAM_ALLOWED_USER_IDS: '42', TELEGRAM_VCP_KEY: 'fixture-key',
    TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent', TELEGRAM_DEFAULT_AGENT: 'ExampleAgent',
    TELEGRAM_VCP_BASE_URL: 'http://127.0.0.1:6005/v1', TELEGRAM_VCP_MODEL: 'VCPModelAuto',
    PROJECT_BASE_PATH: path.resolve(__dirname, '..', '..', '..'),
  };
}

test('shutdown drains, aborts, bounds wait, quarantines effects, removes listeners and closes DB in order', async () => {
  const plugin = loadPlugin();
  const events = [];
  let resolveIdle;
  const idle = new Promise((resolve) => { resolveIdle = resolve; });
  const runtime = {
    ensureDirectories() {}, openState() {}, async probeTelegram() {}, async probeVcp() {},
    startHost() {}, async recover() {}, startPoller() {}, snapshot: () => ({}),
    beginDrain() { events.push('drain'); },
    abort() { events.push('abort'); },
    waitForIdle() { events.push('wait'); return idle; },
    markNeedsReview() { events.push('needs_review'); },
    stopHost() { events.push('host_stop'); },
    close() { events.push('close'); },
  };
  await plugin.initialize(raw(), { createRuntime: () => runtime, shutdownTimeoutMs: 5 });
  const shuttingDown = plugin.shutdown();
  await shuttingDown;
  assert.deepEqual(events, ['drain', 'abort', 'wait', 'needs_review', 'host_stop', 'close']);
  resolveIdle();
  await plugin.shutdown();
  assert.deepEqual(events, ['drain', 'abort', 'wait', 'needs_review', 'host_stop', 'close']);
});

test('initialization failure unwinds constructed resources and remains fail closed', async () => {
  const plugin = loadPlugin();
  const events = [];
  const runtime = {
    ensureDirectories() { events.push('directories'); },
    openState() { events.push('database'); },
    async probeTelegram() { throw new Error('secret probe failure'); },
    beginDrain() { events.push('drain'); }, abort() { events.push('abort'); },
    async waitForIdle() { events.push('wait'); }, markNeedsReview() { events.push('needs_review'); },
    stopHost() { events.push('host_stop'); }, close() { events.push('close'); },
  };
  await assert.rejects(
    plugin.initialize(raw(), { createRuntime: () => runtime }),
    (error) => {
      assert.equal(error.code, 'BRIDGE_INITIALIZATION_FAILED');
      assert.equal(`${error.message}\n${error.stack}`.includes('secret probe failure'), false);
      return true;
    },
  );
  assert.deepEqual(events, [
    'directories', 'database', 'drain', 'abort', 'wait', 'needs_review', 'host_stop', 'close',
  ]);
  await assert.rejects(plugin.processToolCall({}), (error) => error.code === 'BRIDGE_NOT_READY');
});
