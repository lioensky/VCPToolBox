'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  ALLOWED_UPDATES,
  TelegramApiError,
  createTelegramClient,
} = require('../src/telegramClient');

const TOKEN = '123456789:fixture_token_material_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const API_PREFIX = `https://api.telegram.org/bot${TOKEN}/`;

function responseJson(value, options = {}) {
  const body = JSON.stringify(value);
  const response = new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...(options.headers ?? {}),
    },
  });
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: options.url ?? `${API_PREFIX}fixture`,
  });
  Object.defineProperty(response, 'redirected', {
    configurable: true,
    value: options.redirected ?? false,
  });
  return response;
}

function assertSanitized(error, code) {
  assert.equal(error instanceof TelegramApiError, true);
  assert.equal(error.code, code);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('fixture secret description'), false);
  return true;
}

test('JSON methods use fixed Telegram endpoints and explicit Bot API 10.3 fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const method = String(url).split('/').at(-1);
    const result = method === 'getMe'
      ? { id: 1, is_bot: true }
      : method === 'getWebhookInfo'
        ? { url: '' }
        : method === 'getUpdates'
          ? []
          : method === 'getFile'
            ? { file_id: 'f1', file_path: 'documents/file_1.txt' }
            : true;
    return responseJson({ ok: true, result }, { url: String(url) });
  };
  const client = createTelegramClient({ token: TOKEN, fetchImpl });

  await client.getMe();
  await client.getWebhookInfo();
  await client.getUpdates({
    offset: '900719925474099312345',
    limit: 50,
    timeout: 30,
    allowedUpdates: ALLOWED_UPDATES,
  });
  await client.sendMessage({ chat_id: '42', text: 'hello' });
  await client.sendMessageDraft({
    chat_id: '42',
    message_thread_id: '7',
    draft_id: 123,
    text: 'partial',
  });
  await client.editMessageText({ chat_id: '42', message_id: '9', text: 'edited' });
  await client.answerCallbackQuery({ callback_query_id: 'cb_1', text: 'checking' });
  await client.getFile('file_1');
  await client.sendChatAction({ chat_id: '42', action: 'typing' });

  assert.deepEqual(calls.map((call) => call.url), [
    'getMe',
    'getWebhookInfo',
    'getUpdates',
    'sendMessage',
    'sendMessageDraft',
    'editMessageText',
    'answerCallbackQuery',
    'getFile',
    'sendChatAction',
  ].map((method) => `${API_PREFIX}${method}`));
  for (const call of calls) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error');
  }

  const updateBody = calls[2].options.body;
  assert.match(updateBody, /"offset":900719925474099312345/);
  assert.deepEqual(JSON.parse(updateBody, (_key, value) => value).allowed_updates, [...ALLOWED_UPDATES]);

  const draft = JSON.parse(calls[4].options.body);
  assert.equal(draft.draft_id, 123);
  assert.equal(draft.can_stop, true);
  assert.equal(draft.keep_on_stop, false);
});

test('client rejects arbitrary allowed updates, zero draft IDs and unsafe request values', async () => {
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async () => responseJson({ ok: true, result: [] }),
  });
  await assert.rejects(
    client.getUpdates({ limit: 1, timeout: 1, allowedUpdates: ['message'] }),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
  await assert.rejects(
    client.sendMessageDraft({ chat_id: '42', draft_id: 0, text: '' }),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
  await assert.rejects(
    client.getFile('../token'),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
});

test('sendMessageDraft accepts only canonical positive decimal private chat ID strings', async () => {
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => responseJson({ ok: true, result: true }, { url: String(url) }),
  });

  for (const chatId of ['-100123', '0', '01', '@name', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      client.sendMessageDraft({ chat_id: chatId, draft_id: 1, text: 'partial' }),
      (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
    );
  }
});

test('sendMessageDraft fixes native stop controls regardless of caller values', async () => {
  let requestBody;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return responseJson({ ok: true, result: true }, { url: String(url) });
    },
  });

  await client.sendMessageDraft({
    chat_id: '42',
    draft_id: 1,
    text: 'partial',
    can_stop: false,
    keep_on_stop: true,
  });

  assert.equal(requestBody.can_stop, true);
  assert.equal(requestBody.keep_on_stop, false);
});

test('strict response parsing classifies API errors without leaking descriptions or token URLs', async () => {
  const fixtures = [
    [{ ok: false, error_code: 401, description: 'fixture secret description' }, 401, 'TELEGRAM_AUTH'],
    [{ ok: false, error_code: 403, description: 'fixture secret description' }, 403, 'TELEGRAM_FORBIDDEN'],
    [{ ok: false, error_code: 400, description: 'fixture secret description' }, 400, 'TELEGRAM_BAD_REQUEST'],
    [{ ok: false, error_code: 409, description: 'fixture secret description' }, 409, 'TELEGRAM_CONFLICT'],
    [{ ok: false, error_code: 429, description: 'fixture secret description', parameters: { retry_after: 7 } }, 429, 'TELEGRAM_RATE_LIMIT'],
    [{ ok: false, error_code: 500, description: 'fixture secret description' }, 500, 'TELEGRAM_SERVER'],
  ];

  for (const [body, status, code] of fixtures) {
    const client = createTelegramClient({
      token: TOKEN,
      fetchImpl: async (url) => responseJson(body, { status, url: String(url) }),
    });
    await assert.rejects(client.getMe(), (error) => {
      assertSanitized(error, code);
      if (code === 'TELEGRAM_RATE_LIMIT') assert.equal(error.retryAfterSec, 7);
      if (code === 'TELEGRAM_CONFLICT') assert.equal(error.conflictKind, null);
      return true;
    });
  }

  const conflictClient = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => responseJson({
      ok: false,
      error_code: 409,
      description: 'fixture secret description',
    }, { status: 409, url: String(url) }),
  });
  await assert.rejects(
    conflictClient.getUpdates({ limit: 1, timeout: 1, allowedUpdates: ALLOWED_UPDATES }),
    (error) => {
      assertSanitized(error, 'TELEGRAM_CONFLICT');
      assert.equal(error.conflictKind, 'duplicate_poller');
      return true;
    },
  );
});

test('malformed, oversized, redirected and missing-result responses fail closed', async () => {
  const cases = [
    [async (url) => {
      const response = new Response('{bad', { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    }, 'TELEGRAM_INVALID_RESPONSE'],
    [async (url) => responseJson({ ok: true }, { url: String(url) }), 'TELEGRAM_INVALID_RESPONSE'],
    [async (url) => responseJson({ ok: true, result: true }, {
      url: String(url),
      headers: { 'content-length': '99999999' },
    }), 'TELEGRAM_RESPONSE_TOO_LARGE'],
    [async () => responseJson({ ok: true, result: true }, {
      url: 'https://example.com/redirected',
      redirected: true,
    }), 'TELEGRAM_REDIRECT_REJECTED'],
    [async () => responseJson({ ok: true, result: true }, {
      url: '',
      redirected: false,
    }), 'TELEGRAM_REDIRECT_REJECTED'],
    [async (url) => {
      const response = new Response('{"ok":true,"result":true}', {
        headers: { 'content-type': 'text/plain' },
      });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    }, 'TELEGRAM_INVALID_RESPONSE'],
  ];

  for (const [fetchImpl, code] of cases) {
    const client = createTelegramClient({ token: TOKEN, fetchImpl, maxJsonBytes: 128 });
    await assert.rejects(client.getMe(), (error) => assertSanitized(error, code));
  }
});

test('malformed 5xx responses remain retryable server failures', async () => {
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      const response = new Response('upstream unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    },
  });
  await assert.rejects(client.getMe(), (error) => {
    assertSanitized(error, 'TELEGRAM_SERVER');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('oversized 5xx is classified before reading its untrusted body', async () => {
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => responseJson({ ok: false }, {
      status: 503,
      url: String(url),
      headers: { 'content-length': '99999999' },
    }),
    maxJsonBytes: 64,
  });
  await assert.rejects(client.getMe(), (error) => assertSanitized(error, 'TELEGRAM_SERVER'));
});

test('oversized Content-Length early rejection best-effort cancels the response body', async () => {
  let cancelCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => ({
      status: 200,
      ok: true,
      redirected: false,
      url: String(url),
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-length') return String((8 * 1024 * 1024) + 1);
          if (name.toLowerCase() === 'content-type') return 'application/json';
          return null;
        },
      },
      body: {
        cancel() {
          cancelCalls += 1;
          return Promise.reject(new Error('fixture secret description'));
        },
      },
    }),
  });

  await assert.rejects(
    client.getMe(),
    (error) => assertSanitized(error, 'TELEGRAM_RESPONSE_TOO_LARGE'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
});

test('non-OK file download best-effort cancels the response body', async () => {
  let cancelCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => ({
      status: 404,
      ok: false,
      redirected: false,
      url: String(url),
      headers: { get() { return null; } },
      body: {
        cancel() {
          cancelCalls += 1;
          return Promise.reject(new Error('fixture secret description'));
        },
      },
    }),
  });

  await assert.rejects(
    client.downloadFile('documents/missing.bin'),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_RESPONSE'),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
});

test('response-body timeout, external abort and stream errors stay bounded and sanitized', async () => {
  const stalledFetch = async (url) => {
    const stream = new ReadableStream({ start() {} });
    const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  const timeoutClient = createTelegramClient({
    token: TOKEN,
    fetchImpl: stalledFetch,
    requestTimeoutMs: 15,
  });
  await assert.rejects(timeoutClient.getMe(), (error) => assertSanitized(error, 'TELEGRAM_TIMEOUT'));

  const abortClient = createTelegramClient({ token: TOKEN, fetchImpl: stalledFetch });
  const controller = new AbortController();
  const pending = abortClient.getMe({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, (error) => assertSanitized(error, 'TELEGRAM_ABORTED'));

  const errorClient = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      const stream = new ReadableStream({
        start(streamController) {
          streamController.error(new Error(`raw ${TOKEN}`));
        },
      });
      const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    },
  });
  await assert.rejects(errorClient.getMe(), (error) => assertSanitized(error, 'TELEGRAM_NETWORK'));
});

test('invalid fetch response objects are converted to sanitized API failures', async () => {
  const client = createTelegramClient({ token: TOKEN, fetchImpl: async () => null });
  await assert.rejects(client.getMe(), (error) => assertSanitized(error, 'TELEGRAM_INVALID_RESPONSE'));

  const hostile = createTelegramClient({
    token: TOKEN,
    fetchImpl: async () => ({
      get redirected() { throw new Error(`raw ${TOKEN}`); },
    }),
  });
  await assert.rejects(hostile.getMe(), (error) => assertSanitized(error, 'TELEGRAM_NETWORK'));
});

test('streamed JSON enforces the actual byte bound even without Content-Length', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, result: 'x'.repeat(200) }));
  const fetchImpl = async (url) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 50));
        controller.enqueue(bytes.subarray(50));
        controller.close();
      },
    });
    const response = new Response(stream, { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  };
  const client = createTelegramClient({ token: TOKEN, fetchImpl, maxJsonBytes: 64 });
  await assert.rejects(client.getMe(), (error) => assertSanitized(error, 'TELEGRAM_RESPONSE_TOO_LARGE'));
});

for (const method of ['getMe', 'downloadFile']) {
  for (const cancelKind of ['pending', 'reject', 'throw']) {
    test(`${method} oversized stream stays TOO_LARGE with ${cancelKind} cancellation`, async () => {
      let releaseCancel;
      let cancelCalls = 0;
      const client = createTelegramClient({
        token: TOKEN,
        maxJsonBytes: 64,
        requestTimeoutMs: 15,
        fetchImpl: async (url) => {
          const body = new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(65)); },
            cancel() {
              cancelCalls += 1;
              if (cancelKind === 'throw') throw new Error('fixture secret description');
              if (cancelKind === 'reject') return Promise.reject(new Error('fixture secret description'));
              return new Promise((_resolve, reject) => {
                releaseCancel = () => reject(new Error('fixture secret description'));
              });
            },
          });
          const response = new Response(body, { headers: { 'content-type': 'application/json' } });
          Object.defineProperty(response, 'url', { value: String(url) });
          return response;
        },
      });
      const request = method === 'getMe'
        ? client.getMe()
        : client.downloadFile('documents/fixture.bin', { maxBytes: 64 });
      let failure;
      const observed = request.then(() => { failure = null; }, (error) => { failure = error; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.ok(failure, 'size rejection must settle even when cancellation outlives the deadline');
        assertSanitized(failure, 'TELEGRAM_RESPONSE_TOO_LARGE');
        assert.equal(cancelCalls, 1);
      } finally {
        releaseCancel?.();
        await observed;
      }
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

test('a synchronous reader.cancel throw cannot escape the abort listener in strict mode', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { createTelegramClient } = require(${JSON.stringify(require.resolve('../src/telegramClient'))});
    let reading;
    const ready = new Promise(resolve => { reading = resolve; });
    const client = createTelegramClient({ token: ${JSON.stringify(TOKEN)}, fetchImpl: async url => ({
      url, redirected: false, status: 200, ok: true,
      headers: { get: name => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => ({
        read() { reading(); return new Promise(() => {}); },
        cancel() { throw new Error('fixture secret description'); },
        releaseLock() {},
      }) },
    }) });
    (async () => {
      const controller = new AbortController();
      const pending = client.getMe({ signal: controller.signal, timeoutMs: 1000 });
      const result = assert.rejects(pending, error => error.code === 'TELEGRAM_ABORTED');
      await ready;
      controller.abort();
      await result;
    })();
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
    encoding: 'utf8', timeout: 3000,
  });
  assert.equal(child.status, 0, 'cancellation exceptions must be contained');
  assert.equal(child.signal, null);
});

test('external abort and internal timeout are distinct sanitized failures', async () => {
  const hangingFetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const client = createTelegramClient({ token: TOKEN, fetchImpl: hangingFetch, requestTimeoutMs: 15 });
  await assert.rejects(client.getMe(), (error) => assertSanitized(error, 'TELEGRAM_TIMEOUT'));

  const controller = new AbortController();
  const request = client.getMe({ signal: controller.signal, timeoutMs: 1000 });
  controller.abort('shutdown');
  await assert.rejects(request, (error) => assertSanitized(error, 'TELEGRAM_ABORTED'));
});

test('hostile controlOptions getters fail before fetch with a sanitized invalid request', async () => {
  let fetchCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch must not run');
    },
  });
  const fixtures = [
    ['timeoutMs', (controlOptions) => client.getMe(controlOptions)],
    ['signal', (controlOptions) => client.getMe(controlOptions)],
    ['maxBytes', (controlOptions) => client.downloadFile('documents/file.bin', controlOptions)],
  ];

  for (const [property, invoke] of fixtures) {
    const controlOptions = {};
    Object.defineProperty(controlOptions, property, {
      get() { throw new Error('fixture secret description'); },
    });
    await assert.rejects(
      invoke(controlOptions),
      (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
    );
  }
  assert.equal(fetchCalls, 0);
});

test('long-poll deadline adds millisecond grace to Telegram timeout seconds', async () => {
  const hangingFetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: hangingFetch,
    requestGraceMs: 10,
  });
  const started = Date.now();
  await assert.rejects(
    client.getUpdates({ limit: 1, timeout: 0, allowedUpdates: ALLOWED_UPDATES }),
    (error) => assertSanitized(error, 'TELEGRAM_TIMEOUT'),
  );
  assert.ok(Date.now() - started < 500, 'grace must be milliseconds, not seconds');
});

test('multipart upload and bounded file download never allow path-controlled origins', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/file/bot')) {
      const response = new Response(new TextEncoder().encode('downloaded'), {
        headers: { 'content-length': '10' },
      });
      Object.defineProperty(response, 'url', { value: String(url) });
      return response;
    }
    return responseJson({ ok: true, result: { message_id: 1 } }, { url: String(url) });
  };
  const client = createTelegramClient({ token: TOKEN, fetchImpl });
  const file = new Blob(['hello'], { type: 'text/plain' });
  await client.sendDocument({ chat_id: '42', caption: 'safe' }, file, 'note.txt');
  const downloaded = await client.downloadFile('documents/file_1.txt', { maxBytes: 20 });

  assert.equal(calls[0].url, `${API_PREFIX}sendDocument`);
  assert.equal(calls[0].options.body instanceof FormData, true);
  assert.equal(calls[0].options.body.get('chat_id'), '42');
  assert.equal(calls[0].options.body.get('document') instanceof Blob, true);
  assert.equal(calls[1].url, `https://api.telegram.org/file/bot${TOKEN}/documents/file_1.txt`);
  assert.equal(new TextDecoder().decode(downloaded), 'downloaded');

  await assert.rejects(
    client.downloadFile('../escape', { maxBytes: 20 }),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
  await assert.rejects(
    client.downloadFile('documents/file_1.txt', { maxBytes: 20_000_001 }),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
  await assert.rejects(
    client.sendDocument({ chat_id: '42', document: 'duplicate' }, file, 'note.txt'),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
});

test('multipart upload rejects an overlong MIME type before fetch', async () => {
  let fetchCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      return responseJson({ ok: true, result: true }, { url: String(url) });
    },
  });
  const file = new Blob(['x'], { type: `application/${'a'.repeat(200)}` });

  await assert.rejects(
    client.sendDocument({}, file, 'x'),
    (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
  );
  assert.equal(fetchCalls, 0);
});

test('multipart hard-limit estimate includes MIME bytes with one bounded backing allocation', async () => {
  let fetchCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    maxOutboundBytes: 50_000_000,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      return responseJson({ ok: true, result: true }, { url: String(url) });
    },
  });
  const filename = 'x';
  const fixtureSize = 50_000_000 - 65_536 - Buffer.byteLength(filename, 'utf8');
  let source = Buffer.allocUnsafe(fixtureSize);
  let file = new Blob([source], { type: 'application/fixture' });
  source = null;

  try {
    await assert.rejects(
      client.sendDocument({}, file, filename),
      (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
    );
  } finally {
    file = null;
  }
  assert.equal(fetchCalls, 0);
});

test('multipart upload reads native Blob slots instead of lying subclass getters', async () => {
  class LyingBlob extends Blob {
    get size() { return 1; }
    get type() { return 'text/plain'; }
  }

  let fetchCalls = 0;
  const client = createTelegramClient({
    token: TOKEN,
    maxOutboundBytes: 50_000_000,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      return responseJson({ ok: true, result: true }, { url: String(url) });
    },
  });
  let source = Buffer.allocUnsafe(50_000_001);
  let file = new LyingBlob([source], { type: 'application/octet-stream' });
  source = null;
  const nativeSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get;

  try {
    assert.equal(file.size, 1);
    assert.equal(nativeSizeGetter.call(file), 50_000_001);
    await assert.rejects(
      client.sendDocument({}, file, 'oversized.bin'),
      (error) => assertSanitized(error, 'TELEGRAM_INVALID_REQUEST'),
    );
  } finally {
    file = null;
  }
  assert.equal(fetchCalls, 0);
});

test('multipart FormData receives a normalized Blob for an accepted subclass', async () => {
  class LyingBlob extends Blob {
    get size() { return 1; }
    get type() { return 'text/plain'; }
  }

  let document;
  const client = createTelegramClient({
    token: TOKEN,
    fetchImpl: async (url, options) => {
      document = options.body.get('document');
      return responseJson({ ok: true, result: true }, { url: String(url) });
    },
  });
  const file = new LyingBlob([Buffer.from('fixture')], { type: 'application/octet-stream' });

  await client.sendDocument({}, file, 'fixture.bin');
  assert.equal(document.size, 7);
  assert.equal(document.type, 'application/octet-stream');
});

test('client configuration cannot exceed official decimal upload/download ceilings', () => {
  assert.throws(
    () => createTelegramClient({ token: TOKEN, fetchImpl: async () => null, maxInboundBytes: 20_000_001 }),
    (error) => assertSanitized(error, 'TELEGRAM_CONFIG_INVALID'),
  );
  assert.throws(
    () => createTelegramClient({ token: TOKEN, fetchImpl: async () => null, maxOutboundBytes: 50_000_001 }),
    (error) => assertSanitized(error, 'TELEGRAM_CONFIG_INVALID'),
  );
});

test('preview deadlines bound a transport that ignores AbortSignal and dispose its late response', async () => {
  let resolveFetch;
  let cancelled = 0;
  const client = createTelegramClient({ token: TOKEN, fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) });
  const draft = client.sendMessageDraft({ chat_id: '42', draft_id: 123, text: 'partial' }, { timeoutMs: 10 });
  let code;
  const observed = draft.catch(error => { assertSanitized(error, 'TELEGRAM_TIMEOUT'); code = error.code; });
  await new Promise(resolve => setTimeout(resolve, 40));
  try { assert.equal(code, 'TELEGRAM_TIMEOUT'); }
  finally {
    resolveFetch({ status: 200, ok: true, url: `${API_PREFIX}sendMessageDraft`, redirected: false,
      headers: { get: () => 'application/json' }, body: { cancel() { cancelled++; } },
      arrayBuffer: async () => new TextEncoder().encode('{"ok":true,"result":true}').buffer });
    await observed;
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('an already-aborted request never starts fetch', async () => {
  let calls = 0;
  const client = createTelegramClient({ token: TOKEN, fetchImpl: async url => {
    calls++;
    return responseJson({ ok: true, result: true }, { url: String(url) });
  } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.sendMessageDraft({ chat_id: '42', draft_id: 123, text: 'partial' }, { signal: controller.signal }),
    error => assertSanitized(error, 'TELEGRAM_ABORTED'));
  assert.equal(calls, 0);
});

test('only an exact edit no-op is a confirmed result without disclosing Telegram descriptions', async () => {
  const client = createTelegramClient({ token: TOKEN, fetchImpl: async url => responseJson({ ok: false, error_code: 400,
    description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
  }, { status: 400, url: String(url) }) });
  assert.deepEqual(await client.editMessageText({ chat_id: '42', message_id: '9007199254740993', text: 'answer' }),
    { message_id: '9007199254740993' });
  await assert.rejects(client.sendMessage({ chat_id: '42', text: 'answer' }), error => assertSanitized(error, 'TELEGRAM_BAD_REQUEST'));
});
