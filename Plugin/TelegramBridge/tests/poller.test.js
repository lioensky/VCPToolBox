'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ALLOWED_UPDATES, TelegramApiError } = require('../src/telegramClient');
const { TelegramPollerError, createTelegramPoller } = require('../src/telegramPoller');
const { createSessionStore } = require('../src/sessionStore');

function telegramError(code, fields = {}) {
  return new TelegramApiError(code, fields);
}

function assertPollerSanitized(error, code) {
  assert.equal(error instanceof TelegramPollerError, true);
  assert.equal(error.code, code);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  assert.equal(serialized.includes('fixture secret description'), false);
  return true;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture timeout');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function preflightClient(overrides = {}) {
  return {
    async getMe() { return { id: 1, is_bot: true }; },
    async getWebhookInfo() { return { url: '' }; },
    ...overrides,
  };
}

function ledgerStub(overrides = {}) {
  return {
    getNextOffset: () => null,
    acceptBatch: () => ({ inserted: 0, duplicates: 0, nextOffset: null }),
    getPollerState: () => ({ lastSuccessAt: null, duplicatePollerAt: null }),
    recordPollerSuccess: (at) => ({ changed: true, at }),
    recordDuplicatePoller: (at) => ({ changed: true, at }),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settlesWithin(promise, ms = 150) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle within bound')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixtureLedger(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-dispatch-'));
  const store = createSessionStore({
    pluginRoot: root,
    stateDir: path.join(root, 'state'),
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  store.open();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store.createUpdateLedger();
}

test('probe validates bot identity and fails closed on configured webhook without polling or deletion', async () => {
  let updates = 0;
  let deleted = 0;
  const client = preflightClient({
    async getWebhookInfo() { return { url: 'https://example.com/hook' }; },
    async getUpdates() { updates += 1; return []; },
    async deleteWebhook() { deleted += 1; },
  });
  const ledger = ledgerStub({ acceptBatch: () => assert.fail('must not persist') });
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });

  await assert.rejects(poller.probe(), (error) => error.code === 'TELEGRAM_WEBHOOK_ACTIVE');
  assert.equal(updates, 0);
  assert.equal(deleted, 0);
  assert.equal(poller.snapshot().state, 'fatal');
});

test('poll cycle persists a whole batch before the next call and always sends explicit allowed updates', async () => {
  const events = [];
  let calls = 0;
  let secondSignal;
  const client = preflightClient({
    async getUpdates(options) {
      calls += 1;
      events.push({ kind: 'poll', call: calls, options });
      if (calls === 1) {
        return [
          { update_id: 9, message: { message_id: 1, text: 'a' } },
          { update_id: 12, callback_query: { id: 'c' } },
        ];
      }
      secondSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    },
  });
  let nextOffset = null;
  const ledger = ledgerStub({
    getNextOffset() { return nextOffset; },
    acceptBatch(items) {
      events.push({ kind: 'persist', items });
      nextOffset = '13';
      return { inserted: items.length, nextOffset };
    },
  });
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });
  const running = poller.start();
  await waitFor(() => calls === 2);

  assert.deepEqual(events.map((event) => event.kind), ['poll', 'persist', 'poll']);
  assert.deepEqual(events[0].options.allowedUpdates, [...ALLOWED_UPDATES]);
  assert.equal(Object.hasOwn(events[0].options, 'offset'), false);
  assert.equal(events[1].items[0].updateId, '9');
  assert.equal(events[1].items[0].updateType, 'message');
  assert.equal(events[2].options.offset, '13');
  assert.deepEqual(events[2].options.allowedUpdates, [...ALLOWED_UPDATES]);
  assert.equal(secondSignal.aborted, false);

  await poller.stop();
  await running;
  assert.equal(secondSignal.aborted, true);
  assert.equal(poller.snapshot().state, 'stopped');
});

test('only one start loop and one in-flight getUpdates exist', async () => {
  let active = 0;
  let maximum = 0;
  const client = preflightClient({
    async getUpdates({ signal }) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
        });
      } finally {
        active -= 1;
      }
    },
  });
  const ledger = ledgerStub();
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });
  const first = poller.start();
  const second = poller.start();
  assert.equal(first, second);
  await waitFor(() => active === 1);
  assert.equal(maximum, 1);
  await poller.stop();
  await first;
});

test('409 duplicate poller enters fatal standby and is never retried', async () => {
  let calls = 0;
  let recorded = 0;
  const client = preflightClient({
    async getUpdates() {
      calls += 1;
      throw telegramError('TELEGRAM_CONFLICT', { conflictKind: 'duplicate_poller', httpStatus: 409 });
    },
  });
  const ledger = ledgerStub({
    acceptBatch: () => assert.fail('no batch'),
    recordDuplicatePoller: (at) => { recorded += 1; return { changed: true, at }; },
  });
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });
  await poller.start();
  assert.equal(calls, 1);
  assert.equal(recorded, 1);
  const originalFields = ['state', 'active', 'probed', 'failureCount', 'lastErrorCode',
    'lastSuccessAt', 'backoffMs', 'possibleGap'];
  const snapshot = poller.snapshot();
  assert.deepEqual(Object.fromEntries(originalFields.map((key) => [key, snapshot[key]])), {
    state: 'duplicate_poller',
    active: false,
    probed: true,
    failureCount: 0,
    lastErrorCode: 'TELEGRAM_CONFLICT',
    lastSuccessAt: null,
    backoffMs: 0,
    possibleGap: false,
  });
});

test('authentication and bad-request poll failures enter fatal state without retry', async () => {
  for (const code of ['TELEGRAM_AUTH', 'TELEGRAM_FORBIDDEN', 'TELEGRAM_BAD_REQUEST']) {
    let calls = 0;
    const client = preflightClient({
      async getUpdates() { calls += 1; throw telegramError(code); },
    });
    const ledger = ledgerStub({ acceptBatch: () => assert.fail('no batch') });
    const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });
    await poller.start();
    assert.equal(calls, 1);
    assert.equal(poller.snapshot().state, 'fatal');
    assert.equal(poller.snapshot().lastErrorCode, code);
  }
});

test('429 uses retry_after with bounded positive jitter before retry', async () => {
  const sleeps = [];
  let calls = 0;
  let stopSignal;
  const client = preflightClient({
    async getUpdates({ signal }) {
      calls += 1;
      if (calls === 1) {
        throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 3, httpStatus: 429 });
      }
      stopSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    },
  });
  const ledger = ledgerStub();
  const poller = createTelegramPoller({
    client,
    ledger,
    timeoutSec: 30,
    limit: 50,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const running = poller.start();
  await waitFor(() => calls === 2);
  assert.deepEqual(sleeps, [3500]);
  assert.equal(poller.snapshot().failureCount, 1);
  await poller.stop();
  await running;
  assert.equal(stopSignal.aborted, true);
});

test('network and server failures use capped exponential backoff reset by success', async () => {
  const sleeps = [];
  let calls = 0;
  const client = preflightClient({
    async getUpdates({ signal }) {
      calls += 1;
      if (calls === 1) throw telegramError('TELEGRAM_NETWORK', { retryable: true });
      if (calls === 2) throw telegramError('TELEGRAM_SERVER', { retryable: true, httpStatus: 503 });
      if (calls === 3) return [];
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    },
  });
  const ledger = ledgerStub();
  const poller = createTelegramPoller({
    client,
    ledger,
    timeoutSec: 30,
    limit: 50,
    random: () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const running = poller.start();
  await waitFor(() => calls === 4);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(poller.snapshot().failureCount, 0);
  await poller.stop();
  await running;
});

test('old or unallowed update types are durably rejected while offset advances', async () => {
  let persisted;
  const client = preflightClient({
    async getUpdates() {
      return [{ update_id: 30, edited_message: { message_id: 1 } }];
    },
  });
  const ledger = ledgerStub({
    getNextOffset: () => null,
    acceptBatch(items) { persisted = items; return { inserted: 1, nextOffset: '31' }; },
  });
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });
  await poller.runOnce();
  assert.equal(persisted[0].updateType, 'edited_message');
  assert.equal(persisted[0].updateId, '30');
  assert.equal(persisted[0].rejectErrorCode, 'UNSUPPORTED_UPDATE_TYPE');
});

test('poller integrates with the real durable ledger and deduplicates a replayed batch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poller-ledger-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  fs.mkdirSync(pluginRoot);
  const store = createSessionStore({
    pluginRoot,
    stateDir: path.join(pluginRoot, 'state'),
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  store.open();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ledger = store.createUpdateLedger();
  const update = { update_id: 41, message: { message_id: 5, text: 'fixture' } };
  const client = preflightClient({ async getUpdates() { return [update]; } });
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 });

  assert.deepEqual(await poller.runOnce(), { inserted: 1, duplicates: 0, nextOffset: '42' });
  assert.deepEqual(await poller.runOnce(), { inserted: 0, duplicates: 1, nextOffset: '42' });
  assert.equal(ledger.getNextOffset(), '42');
  assert.equal(ledger.getUpdate('41').updateType, 'message');
  assert.equal(ledger.getPollerState().lastSuccessAt !== null, true);
});

test('concurrent public runOnce calls still probe once and allow only one in-flight poll', async () => {
  let getMeCalls = 0;
  let webhookCalls = 0;
  let activePolls = 0;
  let maximumPolls = 0;
  const client = preflightClient({
    async getMe() { getMeCalls += 1; return { id: 1, is_bot: true }; },
    async getWebhookInfo() { webhookCalls += 1; return { url: '' }; },
    async getUpdates({ signal }) {
      activePolls += 1;
      maximumPolls = Math.max(maximumPolls, activePolls);
      try {
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
        });
      } finally {
        activePolls -= 1;
      }
    },
  });
  const poller = createTelegramPoller({ client, ledger: ledgerStub(), timeoutSec: 30, limit: 50 });
  const controller = new AbortController();
  const first = poller.runOnce({ signal: controller.signal });
  await waitFor(() => activePolls === 1);
  await assert.rejects(
    poller.runOnce(),
    (error) => error.code === 'TELEGRAM_POLL_IN_PROGRESS',
  );
  assert.equal(getMeCalls, 1);
  assert.equal(webhookCalls, 1);
  assert.equal(maximumPolls, 1);
  controller.abort();
  await assert.rejects(first, (error) => error.code === 'TELEGRAM_ABORTED');
});

test('ignored runOnce rejection is contained under strict unhandled-rejection mode', () => {
  const pollerPath = path.join(__dirname, '..', 'src', 'telegramPoller.js');
  const clientPath = path.join(__dirname, '..', 'src', 'telegramClient.js');
  const script = [
    `'use strict';`,
    `const { createTelegramPoller } = require(${JSON.stringify(pollerPath)});`,
    `const { TelegramApiError } = require(${JSON.stringify(clientPath)});`,
    `const client = {`,
    `  async getMe() { return { id: 1, is_bot: true }; },`,
    `  async getWebhookInfo() { return { url: '' }; },`,
    `  async getUpdates() { throw new TelegramApiError('TELEGRAM_NETWORK', { retryable: true }); },`,
    `};`,
    `const ledger = {`,
    `  getNextOffset() { return null; },`,
    `  acceptBatch() { return { inserted: 0, duplicates: 0, nextOffset: null }; },`,
    `  getPollerState() { return { lastSuccessAt: null, duplicatePollerAt: null }; },`,
    `  recordPollerSuccess(at) { return { changed: true, at }; },`,
    `  recordDuplicatePoller(at) { return { changed: true, at }; },`,
    `};`,
    `createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50 }).runOnce();`,
    `setTimeout(() => {}, 25);`,
  ].join('\n');
  const child = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    '-e',
    script,
  ], { encoding: 'utf8', timeout: 5000 });

  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  assert.equal(child.signal, null);
});

test('probe rechecks shutdown admission after a reentrant signal getter', async () => {
  let networkCalls = 0;
  let stopping;
  const client = preflightClient({
    async getMe() { networkCalls += 1; return { id: 1, is_bot: true }; },
    async getWebhookInfo() { networkCalls += 1; return { url: '' }; },
    async getUpdates() { networkCalls += 1; return []; },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });
  const externalController = new AbortController();
  const controlOptions = {};
  Object.defineProperty(controlOptions, 'signal', {
    get() {
      stopping = poller.stop();
      return externalController.signal;
    },
  });
  const probing = poller.probe(controlOptions);
  probing.catch(() => {});

  await stopping;
  await assert.rejects(
    probing,
    (error) => assertPollerSanitized(error, 'TELEGRAM_POLLER_STOPPING'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkCalls, 0);
  assert.equal(poller.snapshot().state, 'stopped');
});

test('probe and runOnce sanitize hostile signal getter exceptions', async () => {
  let networkCalls = 0;
  const client = preflightClient({
    async getMe() { networkCalls += 1; return { id: 1, is_bot: true }; },
    async getUpdates() { networkCalls += 1; return []; },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });

  for (const invoke of [
    (controlOptions) => poller.probe(controlOptions),
    (controlOptions) => poller.runOnce(controlOptions),
  ]) {
    const controlOptions = {};
    Object.defineProperty(controlOptions, 'signal', {
      get() { throw new Error('fixture secret description'); },
    });
    const operation = invoke(controlOptions);
    assert.equal(operation instanceof Promise, true);
    await assert.rejects(
      operation,
      (error) => assertPollerSanitized(error, 'TELEGRAM_POLLER_INPUT_INVALID'),
    );
  }
  assert.equal(networkCalls, 0);
});

test('stop aborts a startup probe instead of waiting for getMe timeout', async () => {
  let probeSignal;
  const client = preflightClient({
    async getMe({ signal }) {
      probeSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    },
    async getUpdates() { assert.fail('probe must be stopped before polling'); },
  });
  const poller = createTelegramPoller({ client, ledger: ledgerStub(), timeoutSec: 30, limit: 50 });
  const running = poller.start();
  await waitFor(() => probeSignal instanceof AbortSignal);
  await poller.stop();
  await running;
  assert.equal(probeSignal.aborted, true);
  assert.equal(poller.snapshot().state, 'stopped');
});

test('stop aborts and waits for an in-flight public runOnce poll', async () => {
  let pollSignal;
  let abortObserved = false;
  let releasePoll;
  const client = preflightClient({
    async getUpdates({ signal }) {
      pollSignal = signal;
      return new Promise((_resolve, reject) => {
        releasePoll = () => reject(telegramError('TELEGRAM_ABORTED'));
        signal?.addEventListener('abort', () => {
          abortObserved = true;
        }, { once: true });
      });
    },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });
  const runResult = poller.runOnce().then(
    () => ({ error: null }),
    (error) => ({ error }),
  );
  await waitFor(() => typeof releasePoll === 'function');

  let stopSettled = false;
  const stopping = poller.stop().then(() => {
    stopSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(pollSignal instanceof AbortSignal, true);
    assert.equal(abortObserved, true);
    assert.equal(stopSettled, false);
  } finally {
    releasePoll();
    await Promise.allSettled([stopping, runResult]);
  }

  const { error } = await runResult;
  assert.equal(error?.code, 'TELEGRAM_ABORTED');
  assert.equal(stopSettled, true);
  assert.equal(poller.snapshot().active, false);
  assert.equal(poller.snapshot().state, 'stopped');
});

test('start rejects instead of returning an active loop while stop is pending', async () => {
  let releasePoll;
  const client = preflightClient({
    async getUpdates({ signal }) {
      return new Promise((_resolve, reject) => {
        releasePoll = () => reject(telegramError('TELEGRAM_ABORTED'));
        signal.addEventListener('abort', () => {}, { once: true });
      });
    },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });
  const running = poller.start();
  await waitFor(() => typeof releasePoll === 'function');
  const stopping = poller.stop();
  const restart = poller.start();
  restart.catch(() => {});

  try {
    assert.notEqual(restart, running);
    await assert.rejects(
      restart,
      (error) => error.code === 'TELEGRAM_POLLER_STOPPING',
    );
  } finally {
    releasePoll();
    await Promise.allSettled([running, stopping, restart]);
  }
  assert.equal(poller.snapshot().state, 'stopped');
});

test('stop is a linearization barrier against a runOnce-finally restart', async () => {
  let pollCalls = 0;
  const client = preflightClient({
    async getUpdates({ signal }) {
      pollCalls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(telegramError('TELEGRAM_ABORTED'));
        }, { once: true });
      });
    },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });
  const running = poller.runOnce();
  let restartPromise;
  const reentrantRestart = running.finally(() => {
    restartPromise = poller.start();
    restartPromise.catch(() => {});
  }).catch(() => {});
  await waitFor(() => pollCalls === 1);

  try {
    await poller.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pollCalls, 1);
    assert.equal(poller.snapshot().active, false);
    assert.equal(poller.snapshot().state, 'stopped');
    await assert.rejects(
      restartPromise,
      (error) => error.code === 'TELEGRAM_POLLER_STOPPING',
    );
  } finally {
    await poller.stop();
    await Promise.allSettled([running, reentrantRestart, restartPromise]);
  }
});

test('stop owns and aborts a public probe reused by start', async () => {
  let probeSignal;
  let releaseProbe;
  let webhookCalls = 0;
  let pollCalls = 0;
  const client = preflightClient({
    async getMe({ signal }) {
      probeSignal = signal;
      return new Promise((_resolve, reject) => {
        releaseProbe = () => reject(telegramError('TELEGRAM_ABORTED'));
        signal?.addEventListener('abort', releaseProbe, { once: true });
      });
    },
    async getWebhookInfo() { webhookCalls += 1; return { url: '' }; },
    async getUpdates() { pollCalls += 1; return []; },
  });
  const poller = createTelegramPoller({
    client,
    ledger: ledgerStub(),
    timeoutSec: 30,
    limit: 50,
  });
  const probing = poller.probe();
  await waitFor(() => typeof releaseProbe === 'function');
  const running = poller.start();
  let stopSettled = false;
  const stopping = poller.stop().then(() => { stopSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(probeSignal instanceof AbortSignal, true);
    assert.equal(probeSignal.aborted, true);
    await stopping;
    assert.equal(stopSettled, true);
    assert.equal(webhookCalls, 0);
    assert.equal(pollCalls, 0);
    assert.equal(poller.snapshot().state, 'stopped');
  } finally {
    releaseProbe();
    await Promise.allSettled([probing, running, stopping]);
  }
});

test('persisted poll state restores possible-gap and duplicate-poller standby', async () => {
  let calls = 0;
  const client = preflightClient({ async getUpdates() { calls += 1; return []; } });
  const oldSuccess = 1_000;
  const now = oldSuccess + (25 * 60 * 60 * 1000);
  const gapPoller = createTelegramPoller({
    client,
    ledger: ledgerStub({
      getPollerState: () => ({ lastSuccessAt: oldSuccess, duplicatePollerAt: null }),
    }),
    timeoutSec: 30,
    limit: 50,
    clock: () => now,
  });
  assert.equal(gapPoller.snapshot().possibleGap, true);

  const duplicatePoller = createTelegramPoller({
    client,
    ledger: ledgerStub({
      getPollerState: () => ({ lastSuccessAt: oldSuccess, duplicatePollerAt: now - 1 }),
    }),
    timeoutSec: 30,
    limit: 50,
    clock: () => now,
  });
  assert.equal(duplicatePoller.snapshot().state, 'duplicate_poller');
  await duplicatePoller.start();
  await assert.rejects(
    duplicatePoller.probe(),
    (error) => error.code === 'TELEGRAM_POLLER_UNAVAILABLE',
  );
  await assert.rejects(
    duplicatePoller.runOnce(),
    (error) => error.code === 'TELEGRAM_POLLER_UNAVAILABLE',
  );
  assert.equal(calls, 0);
});

test('snapshot contains only safe operational metadata', async () => {
  const client = preflightClient({ async getUpdates() { return []; } });
  let now = 100;
  const ledger = ledgerStub();
  const poller = createTelegramPoller({ client, ledger, timeoutSec: 30, limit: 50, clock: () => now });
  await poller.probe();
  await poller.runOnce();
  const snapshot = poller.snapshot();
  assert.equal(snapshot.lastSuccessAt, 100);
  assert.equal(JSON.stringify(snapshot).includes('update_id'), false);
  assert.equal(JSON.stringify(snapshot).includes('token'), false);
});

test('poller consumes rejected asynchronous ledger misuse before reporting failure', async () => {
  const client = preflightClient({ async getUpdates() { return []; } });
  for (const overrides of [
    { getNextOffset: async () => { throw new Error('raw offset secret'); } },
    { acceptBatch: async () => { throw new Error('raw batch secret'); } },
  ]) {
    const poller = createTelegramPoller({
      client,
      ledger: ledgerStub(overrides),
      timeoutSec: 30,
      limit: 50,
    });
    await assert.rejects(poller.runOnce(), (error) => error.code === 'TELEGRAM_LEDGER_INVALID');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(poller.snapshot().lastSuccessAt, null);
  }

  assert.throws(
    () => createTelegramPoller({
      client,
      ledger: ledgerStub({
        getPollerState: async () => { throw new Error('raw state secret'); },
      }),
      timeoutSec: 30,
      limit: 50,
    }),
    (error) => error.code === 'TELEGRAM_LEDGER_INVALID',
  );
  await new Promise((resolve) => setImmediate(resolve));
});

for (const mode of ['start', 'runOnce']) {
  test(`${mode} dispatch timeout is terminal and retains the persisted ordered batch`, async (t) => {
    const ledger = fixtureLedger(t);
    const work = deferred();
    let dispatchSignal;
    let dispatches = 0;
    let polls = 0;
    const poller = createTelegramPoller({
      client: preflightClient({ async getUpdates() {
        polls += 1;
        return [{ update_id: 41, message: { text: 'fixture secret description' } },
          { update_id: 42, message: {} }];
      } }),
      ledger, timeoutSec: 30, limit: 50, dispatchTimeoutMs: 15,
      onBatch(items, control) {
        dispatches += 1;
        assert.equal(ledger.getNextOffset(), '43');
        assert.equal(ledger.getUpdate('41').status, 'received');
        assert.equal(ledger.getUpdate('42').status, 'received');
        assert.deepEqual(items.map((item) => item.updateId), ['41', '42']);
        assert.equal(Object.isFrozen(items), true);
        dispatchSignal = control?.signal;
        return work.promise;
      },
    });
    const result = poller[mode]().then(() => null, (error) => error);
    try {
      const error = await settlesWithin(result);
      if (mode === 'runOnce') assertPollerSanitized(error, 'TELEGRAM_DISPATCH_TIMEOUT');
      assert.equal(poller.snapshot().state, 'fatal');
      assert.equal(poller.snapshot().lastErrorCode, 'TELEGRAM_DISPATCH_TIMEOUT');
      assert.equal(poller.snapshot().active, false);
      assert.equal(dispatchSignal?.aborted, true);
      assert.equal(ledger.getPollerState().lastSuccessAt, null);
      await poller.start();
      await assert.rejects(poller.runOnce(), (error) => error.code === 'TELEGRAM_POLLER_UNAVAILABLE');
      await poller.stop();
      assert.equal(poller.snapshot().state, 'fatal');
      assert.equal(polls, 1);
      assert.equal(dispatches, 1);
      work.reject(new Error('fixture secret description'));
      await new Promise((resolve) => setImmediate(resolve));
      await poller.start();
      assert.equal(polls, 1, 'late dispatch settlement must not auto-resume intake');
      assert.equal(ledger.getNextOffset(), '43');
      assert.equal(ledger.getUpdate('42').status, 'received');
      assert.equal(JSON.stringify(poller.snapshot()).includes('fixture secret description'), false);
    } finally {
      const stopping = poller.stop();
      work.resolve();
      await Promise.allSettled([result, stopping]);
    }
  });

  test(`${mode} stop bounds dispatch wait and fences restart while the callback is unknown`, async (t) => {
    const ledger = fixtureLedger(t);
    const work = deferred();
    let dispatches = 0;
    let dispatchSignal;
    let polls = 0;
    const poller = createTelegramPoller({
      client: preflightClient({ async getUpdates() {
        polls += 1;
        return [{ update_id: 51, message: {} }];
      } }),
      ledger, timeoutSec: 30, limit: 50,
      onBatch(_items, control) {
        dispatches += 1;
        dispatchSignal = control?.signal;
        return work.promise;
      },
    });
    const running = poller[mode]().then(() => null, (error) => error);
    await waitFor(() => dispatches === 1);
    const stopping = poller.stop();
    assert.equal(poller.stop(), stopping);
    try {
      await settlesWithin(stopping);
      const error = await running;
      if (mode === 'runOnce') assert.equal(error?.code, 'TELEGRAM_ABORTED');
      assert.equal(dispatchSignal?.aborted, true);
      assert.equal(poller.snapshot().state, 'stopped');
      assert.equal(ledger.getNextOffset(), '52');
      assert.equal(ledger.getUpdate('51').status, 'received');
      assert.equal(ledger.getPollerState().lastSuccessAt, null);
      await assert.rejects(poller.start(), (failure) => failure.code === 'TELEGRAM_POLL_IN_PROGRESS');
      await assert.rejects(poller.runOnce(), (failure) => failure.code === 'TELEGRAM_POLL_IN_PROGRESS');
      work.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(polls, 1);
      assert.equal(dispatches, 1);
      assert.equal(ledger.getPollerState().lastSuccessAt, null);
      assert.equal(poller.snapshot().state, 'stopped');
    } finally {
      work.resolve();
      await Promise.allSettled([running, stopping]);
    }
  });
}

test('dispatch options validate bounds and sanitize hostile getters before intake', () => {
  const base = {
    client: preflightClient({ async getUpdates() { return []; } }),
    ledger: ledgerStub(), timeoutSec: 30, limit: 50,
  };
  for (const dispatchTimeoutMs of [null, 0, -1, 1.5, '15', Infinity, NaN, 2 ** 31]) {
    assert.throws(() => createTelegramPoller({ ...base, dispatchTimeoutMs }),
      (error) => assertPollerSanitized(error, 'TELEGRAM_POLLER_CONFIG_INVALID'));
  }
  for (const onStateChange of [false, 1, {}, 'callback']) {
    assert.throws(() => createTelegramPoller({ ...base, onStateChange }),
      (error) => assertPollerSanitized(error, 'TELEGRAM_POLLER_CONFIG_INVALID'));
  }
  for (const field of ['dispatchTimeoutMs', 'onStateChange']) {
    const options = { ...base };
    Object.defineProperty(options, field, { get() { throw new Error('fixture secret description'); } });
    assert.throws(() => createTelegramPoller(options),
      (error) => assertPollerSanitized(error, 'TELEGRAM_POLLER_CONFIG_INVALID'));
  }
});

test('stop during batch persistence prevents dispatch and success recording', async () => {
  let stopping;
  let successes = 0;
  let dispatches = 0;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() { return [{ update_id: 61, message: {} }]; } }),
    ledger: ledgerStub({
      acceptBatch() { stopping = poller.stop(); return { inserted: 1, nextOffset: '62' }; },
      recordPollerSuccess() { successes += 1; },
    }),
    timeoutSec: 30, limit: 50,
    onBatch() { dispatches += 1; },
  });
  await poller.start();
  await stopping;
  assert.equal(dispatches, 0);
  assert.equal(successes, 0);
  assert.equal(poller.snapshot().lastSuccessAt, null);
});

test('a late poll response after stop is retained without dispatch or poll success', async () => {
  const response = deferred();
  let entered = false;
  let persisted = 0;
  let successes = 0;
  let dispatches = 0;
  const poller = createTelegramPoller({
    client: preflightClient({ getUpdates() { entered = true; return response.promise; } }),
    ledger: ledgerStub({
      acceptBatch(items) { persisted += items.length; },
      recordPollerSuccess() { successes += 1; },
    }), timeoutSec: 30, limit: 50,
    onBatch() { dispatches += 1; },
  });
  const running = poller.start();
  await waitFor(() => entered);
  const stopping = poller.stop();
  response.resolve([{ update_id: 71, message: {} }]);
  await Promise.all([running, stopping]);
  assert.equal(persisted, 1);
  assert.equal(dispatches, 0);
  assert.equal(successes, 0);
});

test('clock-driven freshness covers poll grace and the default generous dispatch deadline', async () => {
  let now = 0;
  const response = deferred();
  const work = deferred();
  let entered = false;
  let dispatches = 0;
  const poller = createTelegramPoller({
    client: preflightClient({ getUpdates() { entered = true; return response.promise; } }),
    ledger: ledgerStub(), timeoutSec: 30, limit: 50, clock: () => now,
    onBatch() { dispatches += 1; return work.promise; },
  });
  const running = poller.runOnce().catch(() => {});
  try {
    await waitFor(() => entered);
    let info = poller.snapshot();
    assert.equal(info.phase, 'polling');
    assert.equal(info.phaseStartedAt, 0);
    assert.equal(info.lastProgressAt, 0);
    assert.equal(info.staleAfterMs, 40_000);
    now = 40_000;
    assert.equal(poller.snapshot().stale, false);
    now += 1;
    assert.equal(poller.snapshot().stale, true);
    assert.equal(poller.snapshot().phaseStartedAt, 0, 'snapshot reads cannot refresh a stalled phase');
    response.resolve([{ update_id: 81, message: { date: 30 } }]);
    await waitFor(() => dispatches === 1);
    info = poller.snapshot();
    assert.equal(info.phase, 'dispatching');
    assert.equal(info.phaseStartedAt, 40_001);
    assert.equal(info.lastProgressAt, 40_001);
    assert.equal(info.staleAfterMs, 30_000);
    assert.equal(info.stale, false);
    now += 30_000;
    assert.equal(poller.snapshot().stale, false);
    now += 1;
    assert.equal(poller.snapshot().stale, true);
    work.resolve();
    await running;
    info = poller.snapshot();
    assert.equal(info.phase, 'ready');
    assert.equal(info.lastProgressAt, now);
    assert.equal(info.staleAfterMs, 70_000);
    now += 70_001;
    assert.equal(poller.snapshot().stale, true);
    now += 24 * 60 * 60 * 1000;
    assert.equal(poller.snapshot().possibleGap, true, 'possible-gap must age with the clock');
  } finally {
    const stopping = poller.stop();
    response.resolve([]);
    work.resolve();
    await Promise.allSettled([running, stopping]);
  }
});

test('retry_after remains fresh until its scheduled deadline and clears on retry or stop', async () => {
  let now = 1000;
  let polls = 0;
  const retry = deferred();
  let sleeping = false;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates({ signal }) {
      polls += 1;
      if (polls === 1) throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 120 });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    } }), ledger: ledgerStub(), timeoutSec: 30, limit: 50,
    clock: () => now, random: () => 0.5,
    sleep() { sleeping = true; return retry.promise; },
  });
  const running = poller.start();
  try {
    await waitFor(() => sleeping);
    assert.equal(poller.snapshot().phase, 'backoff');
    assert.equal(poller.snapshot().nextRetryAt, 121_500);
    now = 121_499;
    assert.equal(poller.snapshot().stale, false);
    now = 121_500;
    assert.equal(poller.snapshot().stale, false);
    now += 1;
    assert.equal(poller.snapshot().stale, true);
    retry.resolve();
    await waitFor(() => polls === 2);
    assert.equal(poller.snapshot().nextRetryAt, null);
    assert.equal(poller.snapshot().stale, false);
  } finally {
    await poller.stop();
    retry.resolve();
    await running;
  }
  assert.equal(poller.snapshot().nextRetryAt, null);
});

test('receipt lag uses safe message dates at receipt and exposes no payload or identifiers', async () => {
  let now = 100_500;
  const batches = [
    [{ update_id: 91, message: { date: 98, text: 'fixture secret description', message_id: 1234567 } },
      { update_id: 92, message: { date: 95 } },
      { update_id: 93, callback_query: { message: { date: 1 } } }],
    [{ update_id: 94, message: { date: 102 } }],
    [null, '1', -1, 0, 1.5, Number.MAX_SAFE_INTEGER, {}, true].map((date, index) => (
      { update_id: 100 + index, message: { date } }
    )),
    [],
  ];
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() { return batches.shift(); } }),
    ledger: ledgerStub(), timeoutSec: 30, limit: 50, clock: () => now,
    onBatch() { now += 100; },
  });
  assert.equal(poller.snapshot().latestBatchReceiptLagMs, null);
  assert.equal(poller.snapshot().maxBatchReceiptLagMs, null);
  await poller.runOnce();
  assert.equal(poller.snapshot().latestBatchReceiptLagMs, 5500);
  assert.equal(poller.snapshot().maxBatchReceiptLagMs, 5500);
  await poller.runOnce();
  assert.equal(poller.snapshot().latestBatchReceiptLagMs, 0, 'future dates clamp at zero');
  assert.equal(poller.snapshot().maxBatchReceiptLagMs, 5500);
  await poller.runOnce();
  assert.equal(poller.snapshot().latestBatchReceiptLagMs, null);
  await poller.runOnce();
  assert.equal(poller.snapshot().latestBatchReceiptLagMs, null);
  assert.equal(poller.snapshot().maxBatchReceiptLagMs, 5500);
  const snapshot = poller.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'state', 'active', 'probed', 'failureCount', 'lastErrorCode', 'lastSuccessAt', 'backoffMs',
    'possibleGap', 'phase', 'phaseStartedAt', 'lastProgressAt', 'nextRetryAt',
    'latestBatchReceiptLagMs', 'maxBatchReceiptLagMs', 'stale', 'staleAfterMs',
  ].sort());
  assert.equal(JSON.stringify(snapshot).includes('fixture secret description'), false);
  assert.equal(JSON.stringify(snapshot).includes('1234567'), false);
});

test('diagnostics emit first/resumed success, retry and dispatch transitions without idle poll chatter', async () => {
  const events = [];
  let polls = 0;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates({ signal }) {
      polls += 1;
      if (polls <= 3) return [];
      if (polls === 4) throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 1 });
      if (polls === 5) return [];
      if (polls === 6) return [{ update_id: 111, message: {} }];
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    } }), ledger: ledgerStub(), timeoutSec: 30, limit: 50,
    random: () => 0, sleep: async () => {}, onBatch: async () => {},
    onStateChange(info) { events.push(info); },
  });
  const running = poller.start();
  try {
    await waitFor(() => polls === 7);
    assert.deepEqual(events.map((info) => info.phase), [
      'ready', 'backoff', 'polling', 'ready', 'dispatching', 'ready',
    ]);
    assert.equal(events[1].lastErrorCode, 'TELEGRAM_RATE_LIMIT');
    assert.equal(events[2].nextRetryAt, null);
    assert.equal(events[3].lastErrorCode, null);
    assert.equal(events[0].phase, 'ready', 'diagnostic snapshots are detached values');
  } finally {
    await poller.stop();
    await running;
  }
});

test('diagnostic exceptions are contained and dispatch failure metadata stays allowlisted', async () => {
  for (const callback of [() => { throw new Error('fixture secret description'); },
    async () => { throw new Error('fixture secret description'); }]) {
    const events = [];
    const poller = createTelegramPoller({
      client: preflightClient({ async getUpdates() { return [{ update_id: 121, message: {} }]; } }),
      ledger: ledgerStub(), timeoutSec: 30, limit: 50,
      onBatch() { throw Object.assign(new Error('fixture secret description'), { code: 'FIXTURE_SECRET_1234567' }); },
      onStateChange(info) { events.push(info); return callback(); },
    });
    await poller.start();
    assert.deepEqual(events.map((info) => info.phase), ['dispatching', 'fatal']);
    assert.equal(poller.snapshot().state, 'fatal');
    assert.equal(poller.snapshot().lastErrorCode, 'TELEGRAM_POLLER_FAILED');
    assert.equal(JSON.stringify(events).includes('FIXTURE_SECRET_1234567'), false);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('diagnostic stop at dispatch-start cannot admit the callback or deadlock shutdown', async () => {
  let stopping;
  let dispatches = 0;
  let successes = 0;
  const events = [];
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() { return [{ update_id: 131, message: {} }]; } }),
    ledger: ledgerStub({ recordPollerSuccess() { successes += 1; } }),
    timeoutSec: 30, limit: 50,
    onBatch() { dispatches += 1; },
    onStateChange(info) {
      events.push(info.phase);
      if (info.phase === 'dispatching') stopping = poller.stop();
    },
  });
  const running = poller.start();
  await settlesWithin(running);
  await settlesWithin(stopping);
  assert.deepEqual(events, ['dispatching', 'stopping']);
  assert.equal(dispatches, 0);
  assert.equal(successes, 0);
  assert.equal(poller.snapshot().state, 'stopped');
});

test('cooperative dispatch abort cannot mask timeout even when it also requests stop', async () => {
  const events = [];
  let stopping;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() { return [{ update_id: 141, message: {} }]; } }),
    ledger: ledgerStub(), timeoutSec: 30, limit: 50, dispatchTimeoutMs: 15,
    onBatch(_items, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          stopping = poller.stop();
          reject(telegramError('TELEGRAM_ABORTED'));
        }, { once: true });
      });
    },
    onStateChange(info) { events.push(info); },
  });
  await settlesWithin(poller.start());
  await settlesWithin(stopping);
  assert.equal(poller.snapshot().state, 'fatal');
  assert.equal(poller.snapshot().lastErrorCode, 'TELEGRAM_DISPATCH_TIMEOUT');
  assert.deepEqual(events.map((info) => info.phase), ['dispatching', 'fatal']);
});

test('a successful dispatch releases its deadline and retry hooks cannot start overlapping intake', async () => {
  let polls = 0;
  let restarts = 0;
  const attempts = [];
  const loops = [];
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates({ signal }) {
      polls += 1;
      if (polls === 1) throw telegramError('TELEGRAM_SERVER');
      if (polls === 2) return [{ update_id: 151, message: {} }];
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(telegramError('TELEGRAM_ABORTED')), { once: true });
      });
    } }), ledger: ledgerStub(), timeoutSec: 30, limit: 50, dispatchTimeoutMs: 15,
    sleep: async () => {}, random: () => 0, onBatch: async () => {},
    onStateChange(info) {
      if (info.phase !== 'polling') return;
      restarts += 1;
      loops.push(poller.start());
      attempts.push(poller.runOnce().then(() => null, (error) => error.code));
    },
  });
  const running = poller.start();
  try {
    await waitFor(() => polls === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(polls, 3);
    assert.equal(restarts, 1);
    assert.deepEqual(loops, [running]);
    assert.equal(poller.snapshot().state, 'running');
    assert.equal(poller.snapshot().lastErrorCode, null);
    assert.deepEqual(await Promise.all(attempts), ['TELEGRAM_POLLER_ACTIVE']);
  } finally {
    await poller.stop();
    await running;
  }
});

test('stop during retry_after clears the schedule even when sleep ignores abort', async () => {
  let sleeping = false;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() {
      throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 120 });
    } }), ledger: ledgerStub(), timeoutSec: 30, limit: 50,
    sleep() { sleeping = true; return new Promise(() => {}); }, random: () => 0,
  });
  const running = poller.start();
  await waitFor(() => sleeping);
  assert.equal(typeof poller.snapshot().nextRetryAt, 'number');
  await settlesWithin(poller.stop());
  await running;
  assert.equal(poller.snapshot().nextRetryAt, null);
  assert.equal(poller.snapshot().phase, 'stopped');
});

test('clock failure cannot prevent terminal state or the shutdown barrier from settling', async () => {
  let now = 0;
  const poller = createTelegramPoller({
    client: preflightClient({ async getUpdates() { now = NaN; return []; } }),
    ledger: ledgerStub(), timeoutSec: 30, limit: 50, clock: () => now,
  });
  await settlesWithin(poller.start());
  await settlesWithin(poller.stop());
  now = 1;
  assert.equal(poller.snapshot().state, 'fatal');
  assert.equal(poller.snapshot().lastErrorCode, 'TELEGRAM_POLLER_CLOCK_INVALID');
});
