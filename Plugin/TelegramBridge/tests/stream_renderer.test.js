'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  StreamRendererError,
  createStreamRenderer,
  createTelegramPeerLimiter,
} = require('../src/streamRenderer');

function telegramError(code, fields = {}) {
  const error = new Error('Telegram fixture failure');
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function assertRendererError(error, code) {
  assert.equal(error instanceof StreamRendererError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

function createStore() {
  const calls = { commit: [], claim: [], delivered: [], unknown: [] };
  const statuses = new Map();
  return {
    calls,
    api: Object.freeze({
      getOrCreateDraftId(requestId) { return requestId === 'request-1' ? 123456 : 123457; },
      commitCompletion(input) {
        calls.commit.push(input);
        const deliveryKeys = input.segments.map((_segment, index) => `delivery-${index}`);
        const mediaDeliveryKeys = (input.media ?? []).map((_item, index) => `media-delivery-${index}`);
        for (const key of [...deliveryKeys, ...mediaDeliveryKeys]) {
          if (!statuses.has(key)) statuses.set(key, 'pending');
        }
        if (input.previewDeliveryUnknown) statuses.set(deliveryKeys[0], 'needs_review');
        return {
          changed: true,
          deliveryKeys,
          ...(mediaDeliveryKeys.length === 0 ? {} : { mediaDeliveryKeys }),
        };
      },
      claimDelivery(key) {
        calls.claim.push(key);
        const status = statuses.get(key);
        if (status !== 'pending') return { changed: false, status };
        statuses.set(key, 'sending');
        return { changed: true, status: 'sending' };
      },
      markDeliveryDelivered(key, messageId) {
        calls.delivered.push({ key, messageId });
        statuses.set(key, 'delivered');
        return { changed: true, status: 'delivered' };
      },
      markDeliveryUnknown(key, code) {
        calls.unknown.push({ key, code });
        statuses.set(key, 'needs_review');
        return { changed: true, status: 'needs_review' };
      },
    }),
  };
}

function createTelegram(overrides = {}) {
  const calls = [];
  let nextMessageId = 100;
  const api = {
    async sendMessageDraft(params) {
      calls.push({ method: 'sendMessageDraft', params });
      return true;
    },
    async sendMessage(params) {
      calls.push({ method: 'sendMessage', params });
      return { message_id: String(nextMessageId++) };
    },
    async editMessageText(params) {
      calls.push({ method: 'editMessageText', params });
      return { message_id: String(params.message_id) };
    },
    async sendChatAction(params) {
      calls.push({ method: 'sendChatAction', params });
      return true;
    },
    ...overrides,
  };
  return { api: Object.freeze(api), calls };
}

function createRendererFixture(overrides = {}) {
  const telegram = overrides.telegram ?? createTelegram();
  const store = overrides.store ?? createStore();
  const renderer = createStreamRenderer({
    telegramClient: telegram.api,
    completionStore: store.api,
    requestId: 'request-1',
    chatId: '42',
    threadId: '0',
    privateChat: overrides.privateChat ?? true,
    mode: overrides.mode ?? 'draft',
    clock: overrides.clock ?? Date.now,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    minPreviewIntervalMs: overrides.minPreviewIntervalMs ?? 0,
    minPreviewChars: overrides.minPreviewChars ?? 1,
    ...(overrides.mediaBridge ? { mediaBridge: overrides.mediaBridge } : {}),
    ...(overrides.peerLimiter ? { peerLimiter: overrides.peerLimiter } : {}),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
    ...(overrides.previewTimeoutMs ? { previewTimeoutMs: overrides.previewTimeoutMs } : {}),
  });
  return { renderer, store, telegram };
}

test('private drafts coalesce to the newest sanitized snapshot and final answer uses sendMessage', async () => {
  const { renderer, store, telegram } = createRendererFixture();
  renderer.pushDelta('Hel');
  renderer.pushDelta('lo');
  await renderer.flushPreview();

  const drafts = telegram.calls.filter((call) => call.method === 'sendMessageDraft');
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].params, {
    chat_id: '42', message_thread_id: '0', draft_id: 123456,
    text: 'Hello', can_stop: true, keep_on_stop: false,
  });

  const result = await renderer.finish({
    turnId: 'turn-1', userText: 'question', userTelegramMessageId: '9',
  });
  assert.deepEqual(result, { status: 'delivered', segmentCount: 1 });
  assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
  assert.equal(store.calls.commit.length, 1);
  assert.equal(store.calls.commit[0].assistantText, 'Hello');
  assert.equal(store.calls.commit[0].assistantText.includes('draft'), false);
  assert.deepEqual(store.calls.delivered, [{ key: 'delivery-0', messageId: '100' }]);
});

test('stopping during media resolution prevents final sends and history completion', async () => {
  const controller = new AbortController();
  const f = createRendererFixture({ signal: controller.signal, mediaBridge: {
    async resolveVcpImageCandidate() { controller.abort(); return { mediaKind: 'photo' }; },
    async sendRichMedia() { assert.fail('cancelled media must not send'); },
  } });
  f.renderer.pushDelta('正文 ![图](ExampleAgent/a.png)');
  await assert.rejects(f.renderer.finish({ turnId:'turn-1',userText:'question' }), e => e.code === 'STREAM_ABORTED');
  assert.equal(f.store.calls.commit.length, 0);
  assert.equal(f.telegram.calls.filter(c => c.method === 'sendMessage').length, 0);
});

test('normalizer failure cannot expose source markup or private resource URLs', async()=>{
  const f=createRendererFixture();
  f.renderer.pushDelta('<b></b>'.repeat(4200)+'<img src="http://localhost:6005/pw=fixture-secret/images/a.png">');
  await f.renderer.finish({turnId:'turn-1',userText:'question'});
  assert.doesNotMatch(JSON.stringify(f.store.calls),/fixture-secret|localhost|<img/);
  assert.match(f.store.calls.commit[0].assistantText,/格式暂时无法解析/);
});

test('an unresolvable image is explicitly reported while text still completes', async () => {
  const { renderer, store } = createRendererFixture({ mediaBridge: {
    resolveVcpImageCandidate() { throw new Error('private-path-fixture'); },
    async sendRichMedia() { assert.fail('must not send unresolved image'); },
  } });
  renderer.pushDelta('正文 ![图片](ExampleAgent/missing.png)');
  await renderer.finish({ turnId: 'turn-1', userText: '图片测试' });
  assert.match(store.calls.commit[0].assistantText, /图片.*无法发送/);
  assert.doesNotMatch(JSON.stringify(store.calls), /private-path-fixture|missing.png/);
});

test('split VCP internals never reach previews, final Telegram sends or completion history', async () => {
  const { renderer, store, telegram } = createRendererFixture();
  for (const chunk of [
    'Safe <<<[TOOL_',
    'REQUEST]>>>secret/path<<<[END_TOOL_REQUEST]>>>',
    ' answer <think>reasoning</think> done',
  ]) renderer.pushDelta(chunk);
  await renderer.flushPreview();
  await renderer.finish({ turnId: 'turn-1', userText: 'question' });
  const serialized = JSON.stringify({ calls: telegram.calls, commit: store.calls.commit });
  for (const secret of ['secret/path', 'reasoning', 'TOOL_REQUEST']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(store.calls.commit[0].assistantText, 'Safe answer done');
});

test('preview, final delivery and completion history share one normalized VCPChat document', async () => {
  const { renderer, store, telegram } = createRendererFixture();
  renderer.pushDelta('<div style="color:red"><p>你');
  await renderer.flushPreview();
  renderer.pushDelta('好</p><ul><li>第一项</li></ul></div> [@tail]');
  await renderer.finish({ turnId: 'turn-rich', userText: 'question' });

  const visibleTelegramText = telegram.calls
    .map((call) => call.params?.text)
    .filter((value) => typeof value === 'string');
  assert.equal(visibleTelegramText.some((text) => /<div|style=|\[@tail\]/.test(text)), false);
  assert.equal(visibleTelegramText.some((text) => text.includes('• 第一项')), true);
  assert.equal(store.calls.commit[0].assistantText, '你好\n\n• 第一项');
  assert.deepEqual(
    store.calls.commit[0].segments.map((segment) => segment.plainText).join(''),
    store.calls.commit[0].assistantText,
  );
});

test('rich content that normalizes to no visible text cannot be completed', async () => {
  const { renderer, store, telegram } = createRendererFixture();
  renderer.pushDelta('<script>secret</script><style>hidden</style>');

  await assert.rejects(
    renderer.finish({ turnId: 'turn-empty', userText: 'question' }),
    (error) => assertRendererError(error, 'STREAM_EMPTY_COMPLETION'),
  );
  assert.equal(store.calls.commit.length, 0);
  assert.equal(JSON.stringify(telegram.calls).includes('secret'), false);
});

test('resolved VCP images are committed and confirmed separately after final text', async () => {
  const mediaCalls = [];
  const mediaBridge = {
    resolveVcpImageCandidate(candidate) {
      mediaCalls.push({ method: 'resolve', candidate });
      return Object.freeze({
        mediaKind: 'photo', relativePath: 'ExampleAgent/a.png', mime: 'image/png',
        size: 32, sha256: 'a'.repeat(64), alt: 'ExampleAgent image',
      });
    },
    async sendRichMedia(input) {
      mediaCalls.push({ method: 'send', input });
      return { messageId: '777' };
    },
  };
  const { renderer, store, telegram } = createRendererFixture({ mediaBridge });
  renderer.pushDelta([
    '<p>图片如下</p>',
    '<img src="http://localhost:6005/pw=fixture/images/ExampleAgent/a.png" alt="ExampleAgent image">',
  ].join(''));

  const result = await renderer.finish({ turnId: 'turn-media', userText: 'question' });

  assert.deepEqual(result, { status: 'delivered', segmentCount: 1, mediaCount: 1 });
  assert.equal(store.calls.commit[0].media.length, 1);
  assert.equal(JSON.stringify(store.calls.commit[0]).includes('pw=fixture'), false);
  assert.deepEqual(store.calls.claim, ['delivery-0', 'media-delivery-0']);
  assert.deepEqual(store.calls.delivered, [
    { key: 'delivery-0', messageId: '100' },
    { key: 'media-delivery-0', messageId: '777' },
  ]);
  assert.deepEqual(mediaCalls.map((call) => call.method), ['resolve', 'send']);
  assert.equal(telegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
});

test('an unknown rich-media send is quarantined after text is already confirmed', async () => {
  const mediaBridge = {
    resolveVcpImageCandidate() {
      return Object.freeze({
        mediaKind: 'photo', relativePath: 'ExampleAgent/a.png', mime: 'image/png',
        size: 32, sha256: 'a'.repeat(64), alt: '',
      });
    },
    async sendRichMedia() { throw new Error('network outcome unknown'); },
  };
  const { renderer, store } = createRendererFixture({ mediaBridge });
  renderer.pushDelta('<p>正文</p><img src="http://localhost:6005/pw=fixture/images/ExampleAgent/a.png">');

  await assert.rejects(
    renderer.finish({ turnId: 'turn-media-unknown', userText: 'question' }),
    (error) => assertRendererError(error, 'STREAM_MEDIA_DELIVERY_UNKNOWN'),
  );
  assert.deepEqual(store.calls.delivered, [{ key: 'delivery-0', messageId: '100' }]);
  assert.deepEqual(store.calls.unknown, [{
    key: 'media-delivery-0', code: 'TELEGRAM_MEDIA_NETWORK_UNKNOWN',
  }]);
});

test('draft failure disables previews without creating a persistent fallback bubble', async () => {
  let draftAttempts = 0;
  const telegram = createTelegram({
    async sendMessageDraft(params) {
      telegram.calls.push({ method: 'sendMessageDraft', params });
      draftAttempts += 1;
      throw telegramError('TELEGRAM_BAD_REQUEST');
    },
  });
  const { renderer } = createRendererFixture({ telegram });
  renderer.pushDelta('fallback answer');
  await renderer.flushPreview();
  assert.equal(draftAttempts, 1);
  assert.deepEqual(telegram.calls.map((call) => call.method), ['sendMessageDraft']);

  await renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.equal(telegram.calls.at(-1).method, 'sendMessage');
  assert.equal(telegram.calls.at(-1).params.text, 'fallback answer');
  assert.equal(telegram.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('group edit mode shares typing and edit calls under both official per-peer windows', async () => {
  let now = 0;
  const actionTimes = [];
  const telegram = createTelegram({
    async sendChatAction(params) {
      actionTimes.push(now);
      telegram.calls.push({ method: 'sendChatAction', params });
      return true;
    },
    async editMessageText(params) {
      actionTimes.push(now);
      telegram.calls.push({ method: 'editMessageText', params });
      return { message_id: String(params.message_id) };
    },
    async sendMessage(params) {
      actionTimes.push(now);
      telegram.calls.push({ method: 'sendMessage', params });
      return { message_id: '100' };
    },
  });
  const { renderer } = createRendererFixture({
    telegram,
    privateChat: false,
    mode: 'edit',
    clock: () => now,
    sleep: async (ms) => { now += ms; },
  });
  for (let index = 0; index < 30; index += 1) {
    renderer.pushDelta(String(index % 10));
    await renderer.flushPreview();
    now += 1000;
  }
  for (const timestamp of actionTimes) {
    assert.ok(actionTimes.filter((value) => value >= timestamp && value < timestamp + 5000).length <= 20);
    assert.ok(actionTimes.filter((value) => value >= timestamp && value < timestamp + 30000).length <= 40);
  }
  await renderer.finish({ turnId: 'turn-1', userText: 'question' });
});

test('concurrent renderers can share one peer limiter across active requests', async () => {
  let now = 0;
  const actionTimes = [];
  const telegram = createTelegram({
    async sendMessageDraft(params) {
      actionTimes.push(now);
      telegram.calls.push({ method: 'sendMessageDraft', params });
      return true;
    },
  });
  const limiter = createTelegramPeerLimiter({
    clock: () => now,
    sleep: async (ms) => { now += ms; },
  });
  const first = createRendererFixture({ telegram, peerLimiter: limiter, clock: () => now }).renderer;
  const second = createStreamRenderer({
    telegramClient: telegram.api,
    completionStore: createStore().api,
    requestId: 'request-2', chatId: '42', threadId: '0', privateChat: true,
    mode: 'draft', clock: () => now, sleep: async (ms) => { now += ms; },
    minPreviewIntervalMs: 0, minPreviewChars: 1, peerLimiter: limiter,
  });
  for (let index = 0; index < 15; index += 1) {
    first.pushDelta('a');
    await first.flushPreview();
    second.pushDelta('b');
    await second.flushPreview();
    now += 2000;
  }
  assert.equal(actionTimes.length, 30);
  assert.ok(now >= 5000);
  for (const timestamp of actionTimes) {
    assert.ok(actionTimes.filter((value) => value >= timestamp && value < timestamp + 5000).length <= 20);
  }
  await first.finish({ turnId: 'turn-1', userText: 'question' });
  await second.finish({ turnId: 'turn-2', userText: 'question' });
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('edit mode commits the exact preview target before editing its first final segment', async () => {
  const f = createRendererFixture({ mode: 'edit' });
  f.renderer.pushDelta('partial');
  await f.renderer.flushPreview();
  f.renderer.pushDelta('x'.repeat(5000));
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.equal(f.store.calls.commit[0].previewMessageId, '100');
  const edits = f.telegram.calls.filter(call => call.method === 'editMessageText');
  assert.equal(edits.at(-1).params.message_id, '100');
  assert.equal(edits.at(-1).params.text, f.store.calls.commit[0].segments[0].text);
  assert.equal(f.telegram.calls.filter(call => call.method === 'sendMessage').length, 2);
  assert.deepEqual(f.store.calls.delivered, [
    { key: 'delivery-0', messageId: '100' }, { key: 'delivery-1', messageId: '101' },
  ]);
});

test('edit final HTML fallback keeps the same target and unknown outcome sends no later segments', async () => {
  let finalAttempts = 0;
  const telegram = createTelegram({
    async editMessageText(params) {
      telegram.calls.push({ method: 'editMessageText', params });
      if (params.parse_mode) { finalAttempts++; throw telegramError('TELEGRAM_BAD_REQUEST'); }
      return { message_id: params.message_id };
    },
  });
  const f = createRendererFixture({ mode: 'edit', telegram });
  f.renderer.pushDelta('**answer**');
  await f.renderer.flushPreview();
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.equal(finalAttempts, 1);
  assert.equal(telegram.calls.filter(call => call.method === 'sendMessage').length, 1);
  assert.equal(telegram.calls.at(-1).params.message_id, '100');
  assert.equal(telegram.calls.at(-1).params.text, '**answer**');

  const unknownTelegram = createTelegram({
    async editMessageText() { throw telegramError('TELEGRAM_NETWORK'); },
  });
  const unknown = createRendererFixture({ mode: 'edit', telegram: unknownTelegram });
  unknown.renderer.pushDelta('partial');
  await unknown.renderer.flushPreview();
  unknown.renderer.pushDelta('x'.repeat(5000));
  await assert.rejects(unknown.renderer.finish({ turnId: 'turn-1', userText: 'question' }),
    error => assertRendererError(error, 'STREAM_FINAL_DELIVERY_UNKNOWN'));
  assert.equal(unknownTelegram.calls.filter(call => call.method === 'sendMessage').length, 1);
  assert.equal(unknown.store.calls.unknown.length, 1);
});

test('thousands of deltas require both a real one-second interval and minimum growth', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = createRendererFixture({ minPreviewIntervalMs: 0, minPreviewChars: 12 });
  f.renderer.pushDelta('hello world!');
  await f.renderer.flushPreview();
  for (let i = 0; i < 1000; i++) { f.renderer.pushDelta('x'); await nextTurn(); }
  assert.equal(f.telegram.calls.length, 1, 'character growth must not bypass time');
  await f.renderer.flushPreview();
  t.mock.timers.tick(999);
  await nextTurn();
  assert.equal(f.telegram.calls.length, 1);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(f.telegram.calls.length, 2);
  assert.equal(f.telegram.calls[1].params.text, 'hello world!' + 'x'.repeat(1000));
  f.renderer.pushDelta('y');
  t.mock.timers.tick(2000);
  await f.renderer.flushPreview();
  assert.equal(f.telegram.calls.length, 2, 'elapsed time must not bypass minimum growth');
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  t.mock.timers.tick(30000);
  await nextTurn();
  assert.equal(f.telegram.calls.length, 3, 'no delayed preview after final');
});

test('the preview interval starts after the actual slow preview completes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let release;
  const telegram = createTelegram({
    sendMessageDraft(params) {
      telegram.calls.push({ method: 'sendMessageDraft', params });
      if (telegram.calls.length > 1) return Promise.resolve(true);
      return new Promise(resolve => { release = resolve; });
    },
  });
  const f = createRendererFixture({ telegram });
  f.renderer.pushDelta('first');
  await nextTurn();
  t.mock.timers.tick(800);
  release(true);
  await f.renderer.flushPreview();
  f.renderer.pushDelta('second');
  t.mock.timers.tick(200);
  await nextTurn();
  assert.equal(telegram.calls.length, 1, 'slow completion must not compress the next interval');
  t.mock.timers.tick(800);
  await nextTurn();
  assert.equal(telegram.calls.length, 2);
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
});

test('finish aborts an in-flight draft independently and does not wait for its transport', async () => {
  let previewControl;
  let release;
  const telegram = createTelegram({
    sendMessageDraft(params, control) {
      previewControl = control;
      telegram.calls.push({ method: 'sendMessageDraft', params });
      return new Promise(resolve => { release = resolve; });
    },
  });
  const controller = new AbortController();
  const f = createRendererFixture({ telegram, signal: controller.signal });
  f.renderer.pushDelta('partial');
  await nextTurn();
  const finished = f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  let result;
  finished.then(value => { result = value; });
  await nextTurn();
  try {
    assert.equal(result?.status, 'delivered');
    assert.equal(previewControl.signal.aborted, true);
    assert.notEqual(previewControl.signal, controller.signal);
    assert.equal(controller.signal.aborted, false);
    assert.ok(previewControl.timeoutMs <= 2000);
  } finally { release(true); await finished; }
  await nextTurn();
  assert.deepEqual(telegram.calls.map(call => call.method), ['sendMessageDraft', 'sendMessage']);
});

test('preview waiting in a limiter cannot hold final or send after final', async () => {
  let queued;
  let release;
  let calls = 0;
  const limiter = {
    run(operation) {
      if (++calls !== 1) return operation();
      queued = operation;
      return new Promise(resolve => { release = resolve; });
    },
  };
  const f = createRendererFixture({ peerLimiter: limiter });
  f.renderer.pushDelta('answer');
  await nextTurn();
  const finished = f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  let result;
  finished.then(value => { result = value; });
  await nextTurn();
  try {
    assert.equal(result?.status, 'delivered');
    await assert.rejects(Promise.resolve().then(queued));
  } finally { release(); await finished; }
  assert.deepEqual(f.telegram.calls.map(call => call.method), ['sendMessage']);
});

test('preview timeout disables further preview attempts without poisoning completion', async () => {
  let previewControl;
  const telegram = createTelegram({
    sendMessageDraft(params, control) {
      previewControl = control;
      telegram.calls.push({ method: 'sendMessageDraft', params });
      return new Promise(() => {});
    },
  });
  const f = createRendererFixture({ telegram, previewTimeoutMs: 10 });
  f.renderer.pushDelta('answer');
  const flushed = f.renderer.flushPreview();
  let settled = false;
  flushed.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(settled, true);
  assert.equal(previewControl.signal.aborted, true);
  f.renderer.pushDelta(' done');
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.deepEqual(telegram.calls.map(call => call.method), ['sendMessageDraft', 'sendMessage']);
});

test('best-effort previews reserve limiter headroom and never sleep or retry a 429', async () => {
  let now = 1000;
  const sleeps = [];
  const limiter = createTelegramPeerLimiter({ clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  let previews = 0;
  for (let i = 0; i < 1000; i++) {
    await limiter.run(() => { previews++; }, { bestEffort: true }).catch(() => {});
  }
  assert.ok(previews <= 18);
  assert.deepEqual(sleeps, []);
  await limiter.run(() => 'final');
  assert.deepEqual(sleeps, []);
  const fresh = createTelegramPeerLimiter({ clock: () => now, sleep: async ms => { sleeps.push(ms); now += ms; } });
  let attempts = 0;
  await assert.rejects(fresh.run(() => {
    attempts++;
    throw telegramError('TELEGRAM_RATE_LIMIT', { retryAfterSec: 30 });
  }, { bestEffort: true }));
  await fresh.run(() => 'final');
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test('ambiguous draft failures never create edit previews or delay the final', async () => {
  for (const code of ['TELEGRAM_NETWORK', 'TELEGRAM_TIMEOUT', 'TELEGRAM_SERVER', 'TELEGRAM_RATE_LIMIT']) {
    const telegram = createTelegram({
      async sendMessageDraft(params) {
        telegram.calls.push({ method: 'sendMessageDraft', params });
        throw telegramError(code, { retryAfterSec: 30 });
      },
    });
    const f = createRendererFixture({ telegram });
    f.renderer.pushDelta('answer');
    await f.renderer.flushPreview();
    await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
    assert.deepEqual(telegram.calls.map(call => call.method), ['sendMessageDraft', 'sendMessage']);
  }
});

test('an ambiguous placeholder creation is never replaced by a new final bubble', async () => {
  const telegram = createTelegram({
    async sendMessage(params) {
      telegram.calls.push({ method: 'sendMessage', params });
      throw telegramError('TELEGRAM_NETWORK');
    },
  });
  const f = createRendererFixture({ telegram, mode: 'edit' });
  f.renderer.pushDelta('answer');
  await f.renderer.flushPreview();
  await assert.rejects(f.renderer.finish({ turnId: 'turn-1', userText: 'question' }),
    error => assertRendererError(error, 'STREAM_FINAL_DELIVERY_UNKNOWN'));
  assert.equal(f.store.calls.commit[0].previewDeliveryUnknown, true);
  assert.equal(telegram.calls.length, 1);
});

test('finish during placeholder creation quarantines uncertainty and ignores a late message ID', async () => {
  let release;
  const telegram = createTelegram({
    sendMessage(params) {
      telegram.calls.push({ method: 'sendMessage', params });
      return new Promise(resolve => { release = resolve; });
    },
  });
  const f = createRendererFixture({ telegram, mode: 'edit' });
  f.renderer.pushDelta('answer');
  await nextTurn();
  try {
    await assert.rejects(f.renderer.finish({ turnId: 'turn-1', userText: 'question' }),
      error => assertRendererError(error, 'STREAM_FINAL_DELIVERY_UNKNOWN'));
    assert.equal(f.store.calls.commit[0].previewDeliveryUnknown, true);
  } finally { release({ message_id: '100' }); }
  await nextTurn();
  assert.equal(telegram.calls.length, 1);
});

test('finish cancels a known placeholder edit and finalizes that ID without later preview edits', async () => {
  let release;
  let previewControl;
  const telegram = createTelegram({
    editMessageText(params, control) {
      telegram.calls.push({ method: 'editMessageText', params });
      if (params.parse_mode) return Promise.resolve({ message_id: params.message_id });
      previewControl = control;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const f = createRendererFixture({ telegram, mode: 'edit' });
  f.renderer.pushDelta('answer');
  await nextTurn();
  try {
    await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
    assert.equal(previewControl.signal.aborted, true);
    assert.equal(f.store.calls.commit[0].previewMessageId, '100');
  } finally { release({ message_id: '100' }); }
  await nextTurn();
  assert.deepEqual(telegram.calls.map(call => call.method), ['sendMessage', 'editMessageText', 'editMessageText']);
});

test('a definite placeholder rejection leaves final delivery available', async () => {
  const telegram = createTelegram({
    async sendMessage(params) {
      telegram.calls.push({ method: 'sendMessage', params });
      if (params.text === '…') throw telegramError('TELEGRAM_BAD_REQUEST');
      return { message_id: '101' };
    },
  });
  const f = createRendererFixture({ telegram, mode: 'edit' });
  f.renderer.pushDelta('answer');
  await f.renderer.flushPreview();
  await f.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.equal(f.store.calls.commit[0].previewDeliveryUnknown, undefined);
  assert.deepEqual(f.store.calls.delivered, [{ key: 'delivery-0', messageId: '101' }]);
});

test('Telegram HTML rejection falls back to plain text while unknown network outcome becomes needs_review', async () => {
  let sends = 0;
  const parseTelegram = createTelegram({
    async sendMessage(params) {
      parseTelegram.calls.push({ method: 'sendMessage', params });
      sends += 1;
      if (sends === 1 && params.parse_mode === 'HTML') throw telegramError('TELEGRAM_BAD_REQUEST');
      return { message_id: '501' };
    },
  });
  const parseFixture = createRendererFixture({ telegram: parseTelegram });
  parseFixture.renderer.pushDelta('**formatted**');
  await parseFixture.renderer.finish({ turnId: 'turn-1', userText: 'question' });
  const finalCalls = parseTelegram.calls.filter((call) => call.method === 'sendMessage');
  assert.equal(finalCalls.length, 2);
  assert.equal(finalCalls[0].params.parse_mode, 'HTML');
  assert.equal(Object.hasOwn(finalCalls[1].params, 'parse_mode'), false);
  assert.equal(finalCalls[1].params.text, '**formatted**');

  const networkTelegram = createTelegram({
    async sendMessage(params) {
      networkTelegram.calls.push({ method: 'sendMessage', params });
      throw telegramError('TELEGRAM_NETWORK');
    },
  });
  const unknown = createRendererFixture({ telegram: networkTelegram });
  unknown.renderer.pushDelta('answer');
  await assert.rejects(
    unknown.renderer.finish({ turnId: 'turn-2', userText: 'question' }),
    (error) => assertRendererError(error, 'STREAM_FINAL_DELIVERY_UNKNOWN'),
  );
  assert.equal(networkTelegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
  assert.deepEqual(unknown.store.calls.unknown, [{
    key: 'delivery-0', code: 'TELEGRAM_NETWORK_UNKNOWN',
  }]);
});

test('long answers are sent as <=4096 grapheme-safe plain segments', async () => {
  const { renderer, telegram } = createRendererFixture();
  renderer.pushDelta('👨‍👩‍👧‍👦'.repeat(1000) + 'x'.repeat(5000));
  const result = await renderer.finish({ turnId: 'turn-1', userText: 'question' });
  assert.ok(result.segmentCount > 1);
  const finals = telegram.calls.filter((call) => call.method === 'sendMessage');
  assert.equal(finals.length, result.segmentCount);
  assert.equal(finals.every((call) => !Object.hasOwn(call.params, 'parse_mode')), true);
  assert.equal(finals.every((call) => call.params.text.length <= 4096), true);
});

test('an invalid success response after final send is quarantined as unknown delivery', async () => {
  const telegram = createTelegram({
    async sendMessage(params) {
      telegram.calls.push({ method: 'sendMessage', params });
      return { message_id: 'not-an-id' };
    },
  });
  const fixture = createRendererFixture({ telegram });
  fixture.renderer.pushDelta('answer');
  await assert.rejects(
    fixture.renderer.finish({ turnId: 'turn-1', userText: 'question' }),
    (error) => assertRendererError(error, 'STREAM_FINAL_DELIVERY_UNKNOWN'),
  );
  assert.deepEqual(fixture.store.calls.unknown, [{
    key: 'delivery-0', code: 'TELEGRAM_DELIVERY_CONFIRM_UNKNOWN',
  }]);
});

test('synthetic or incomplete filtered streams cannot be finalized', async () => {
  const synthetic = createRendererFixture();
  assert.throws(
    () => synthetic.renderer.pushDelta('[UPSTREAM_ERROR] secret'),
    (error) => assertRendererError(error, 'STREAM_FILTER_FAILED'),
  );
  const incomplete = createRendererFixture();
  incomplete.renderer.pushDelta('<think>secret');
  await assert.rejects(
    incomplete.renderer.finish({ turnId: 'turn-1', userText: 'question' }),
    (error) => assertRendererError(error, 'STREAM_FILTER_FAILED'),
  );
});
