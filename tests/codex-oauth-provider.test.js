const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CodexOAuthProvider } = require('../modules/providers/codexOAuthProvider');
const createCodexOAuthResponsesRouter = require('../routes/codexOAuthResponses');

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function responsesSseResponse(events, status = 200) {
  return new Response(events.join(''), {
    status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

function responsesSseResponseWithoutContentType(events, status = 200) {
  return new Response(events.join(''), { status });
}

function delayedResponsesSseResponse(events, delayMs = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(events[0]));
      await new Promise(resolve => setTimeout(resolve, delayMs));
      for (const event of events.slice(1)) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
    },
  });
}

test('codex oauth provider forwards responses with OAuth token and account header', async () => {
  const calls = [];
  const oauthAuthManager = {
    async getValidToken(provider, accountId) {
      assert.equal(provider, 'codex_oauth');
      assert.equal(accountId, 'codex_account_1');
      return {
        accessToken: 'access-token-secret',
        account: {
          metadata: {
            chatgptAccountId: 'chatgpt-account-1',
          },
        },
      };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ id: 'resp_test', object: 'response' });
  };
  const provider = new CodexOAuthProvider({
    oauthAuthManager,
    fetchImpl,
    baseUrl: 'https://chatgpt.com/backend-api/codex/',
    accountId: 'codex_account_1',
  });

  const response = await provider.forwardResponses({
    model: 'gpt-5.4-mini',
    input: 'hello',
    stream: false,
    store: true,
  }, {});

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token-secret');
  assert.equal(calls[0].options.headers['ChatGPT-Account-ID'], 'chatgpt-account-1');
  assert.equal(calls[0].options.headers.originator, 'codex_cli_rs');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
});

test('codex oauth provider fetches and normalizes model catalog', async () => {
  const calls = [];
  const oauthAuthManager = {
    async getValidToken(provider, accountId) {
      assert.equal(provider, 'codex_oauth');
      assert.equal(accountId, 'codex_account_1');
      return {
        accessToken: 'access-token-secret',
        account: {
          metadata: {
            chatgptAccountId: 'chatgpt-account-1',
          },
        },
      };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }, 'gpt-5.4-codex'] });
  };
  const provider = new CodexOAuthProvider({
    oauthAuthManager,
    fetchImpl,
    baseUrl: 'https://chatgpt.com/backend-api/codex/',
    accountId: 'codex_account_1',
    clientVersion: '9.9.9',
  });

  const response = await provider.fetchModels();
  const models = createCodexOAuthResponsesRouter.normalizeCodexOAuthModelsPayload(await response.json());

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=9.9.9');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token-secret');
  assert.deepEqual(models.map(model => model.id), ['gpt-5.4-mini', 'gpt-5.4-codex']);
  assert.equal(models[0].owned_by, 'codex_oauth');
  assert.equal(models[1].owned_by, 'codex_oauth');
});

test('codex oauth provider applies an abort signal to upstream requests', async () => {
  const oauthAuthManager = {
    async getValidToken() {
      return {
        accessToken: 'access-token-secret',
        account: { metadata: {} },
      };
    },
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse({ ok: true });
  };
  const provider = new CodexOAuthProvider({
    oauthAuthManager,
    fetchImpl,
    baseUrl: 'https://chatgpt.com/backend-api/codex/',
    timeoutMs: 5000,
  });

  const response = await provider.forwardResponses({ model: 'gpt-5.4-mini' });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls[0].options.signal.aborted, false);
});

test('codex oauth provider keeps timeout active while streaming body is consumed', async () => {
  const oauthAuthManager = {
    async getValidToken() {
      return {
        accessToken: 'access-token-secret',
        account: { metadata: {} },
      };
    },
  };
  let upstreamSignal = null;
  const fetchImpl = async (_url, options = {}) => {
    upstreamSignal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"first"}\n\n'));
      },
      pull() {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          upstreamSignal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
  const provider = new CodexOAuthProvider({
    oauthAuthManager,
    fetchImpl,
    baseUrl: 'https://chatgpt.com/backend-api/codex/',
    timeoutMs: 30,
  });

  const response = await provider.forwardResponses({ model: 'gpt-5.4-mini', stream: true });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(upstreamSignal.aborted, false);

  await assert.rejects(reader.read(), /AbortError|aborted|BodyStreamBuffer was aborted/);
  assert.equal(upstreamSignal.aborted, true);
});

test('codex oauth model list falls back to configured models without leaking errors', async () => {
  const models = await createCodexOAuthResponsesRouter.fetchCodexOAuthModels({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini, gpt-5.4-codex',
    },
    codexOAuthProvider: {
      async fetchModels() {
        throw new Error('raw token failure should stay private');
      },
    },
  });

  assert.deepEqual(models.map(model => model.id), ['gpt-5.4-mini', 'gpt-5.4-codex']);
  assert.equal(models[0].owned_by, 'codex_oauth');
});

test('codex oauth model list uses built-in fallback models when provider is enabled', async () => {
  const models = await createCodexOAuthResponsesRouter.fetchCodexOAuthModels({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
    },
    codexOAuthProvider: {
      async fetchModels() {
        throw new Error('token unavailable');
      },
    },
  });

  assert.deepEqual(models.map(model => model.id), createCodexOAuthResponsesRouter.DEFAULT_CODEX_OAUTH_MODEL_IDS);
  assert.equal(models[0].owned_by, 'codex_oauth');
});

test('codex oauth chat route converts chat completions to responses provider', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses(body, headers) {
        calls.push({ body, headers });
        return responsesSseResponseWithoutContentType([
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello from ' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'codex' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_codex_chat', model: body.model } })}\n\n`,
        ]);
      },
    },
  }));
  app.post('/v1/chat/completions', (_req, res) => {
    res.status(418).json({ fallback: false });
  });

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [
          { role: 'system', content: 'rules' },
          { role: 'user', content: 'hello' },
        ],
        stream: false,
        max_tokens: 123,
        temperature: 0.7,
        top_p: 1,
        metadata: { source: 'vcpchat' },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, 'gpt-5.4-mini');
    assert.equal(calls[0].body.instructions, 'rules');
    assert.equal(calls[0].body.max_output_tokens, undefined);
    assert.equal(calls[0].body.temperature, undefined);
    assert.equal(calls[0].body.top_p, undefined);
    assert.equal(calls[0].body.metadata, undefined);
    assert.equal(calls[0].body.store, false);
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].headers.accept, 'text/event-stream');
    assert.deepEqual(calls[0].body.input, [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.choices[0].message.content, 'hello from codex');
  } finally {
    await closeServer(server);
  }
});

test('codex oauth chat route streams a chat-compatible SSE response', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses() {
        return responsesSseResponse([
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'streamed ' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'codex' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_codex_stream', model: 'gpt-5.4-mini' } })}\n\n`,
        ]);
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /streamed /);
    assert.match(text, /codex/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await closeServer(server);
  }
});

test('codex oauth chat route forwards streaming deltas before upstream completes', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses() {
        return delayedResponsesSseResponse([
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'first' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: ' second' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_delayed', model: 'gpt-5.4-mini' } })}\n\n`,
        ], 250);
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    const elapsed = Date.now() - startedAt;
    await reader.cancel();

    assert.equal(response.status, 200);
    assert.match(firstText, /first/);
    assert.ok(elapsed < 200, `first streamed chunk arrived too late: ${elapsed}ms`);
  } finally {
    await closeServer(server);
  }
});

test('codex oauth chat route supplies default instructions without system message', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses(body) {
        calls.push(body);
        return responsesSseResponseWithoutContentType([
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'default ok' })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_default_instructions', model: body.model } })}\n\n`,
        ]);
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instructions, 'You are ChatGPT, a helpful assistant.');
    assert.equal(payload.choices[0].message.content, 'default ok');
  } finally {
    await closeServer(server);
  }
});

test('codex oauth chatvcp route uses the same provider adapter', async () => {
  let called = false;
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses(body) {
        called = true;
        return responsesSseResponseWithoutContentType([
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `chatvcp ${body.model}` })}\n\n`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_chatvcp', model: body.model } })}\n\n`,
        ]);
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/chatvcp/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(called, true);
    assert.equal(payload.choices[0].message.content, 'chatvcp gpt-5.4-mini');
  } finally {
    await closeServer(server);
  }
});

test('codex oauth chat route skips non-codex models', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    runtimeConfig: {
      VCP_RESPONSES_PROVIDER: 'codex_oauth',
      VCP_CODEX_OAUTH_MODELS: 'gpt-5.4-mini',
    },
    codexOAuthProvider: {
      async fetchModels() {
        return jsonResponse({ models: [{ id: 'gpt-5.4-mini' }] });
      },
      async forwardResponses() {
        throw new Error('should not be called');
      },
    },
  }));
  app.post('/v1/chat/completions', (_req, res) => {
    res.json({ fallback: true });
  });

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'not-codex',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { fallback: true });
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route is opt-in and returns sanitized failures', async () => {
  let called = false;
  const provider = {
    async forwardResponses() {
      called = true;
      throw new Error('raw token failure should stay private');
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    responsesProvider: 'codex_oauth',
    codexOAuthProvider: provider,
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: 'hello' }),
    });
    const payload = await response.json();

    assert.equal(called, true);
    assert.equal(response.status, 502);
    assert.equal(payload.error.type, 'codex_oauth_provider_failed');
    assert.equal(JSON.stringify(payload).includes('raw token failure'), false);
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route supplies default instructions for bridge requests', async () => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    responsesProvider: 'codex_oauth',
    codexOAuthProvider: {
      async forwardResponses(body) {
        calls.push(body);
        return jsonResponse({ id: 'resp_bridge', model: body.model, output_text: 'ok' });
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        stream: false,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.output_text, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instructions, 'You are ChatGPT, a helpful assistant.');
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route sanitizes non-2xx upstream responses', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    responsesProvider: 'codex_oauth',
    codexOAuthProvider: {
      async forwardResponses() {
        return jsonResponse({
          error: 'upstream raw failure',
          access_token: 'secret-access-token',
        }, 401);
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: 'hello' }),
    });
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    assert.equal(response.status, 401);
    assert.equal(payload.error.type, 'codex_oauth_provider_failed');
    assert.equal(serialized.includes('upstream raw failure'), false);
    assert.equal(serialized.includes('secret-access-token'), false);
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route preserves provider error status without leaking details', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    responsesProvider: 'codex_oauth',
    codexOAuthProvider: {
      async forwardResponses() {
        const error = new Error('No OAuth account is available for this provider.');
        error.statusCode = 404;
        throw error;
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: 'hello' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.error.type, 'codex_oauth_provider_failed');
    assert.equal(JSON.stringify(payload).includes('No OAuth account'), false);
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route skips when provider is not enabled', async () => {
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    responsesProvider: '',
    disableConfigFileLookup: true,
    codexOAuthProvider: {
      async forwardResponses() {
        throw new Error('should not be called');
      },
    },
  }));
  app.post('/v1/responses', (_req, res) => {
    res.json({ fallback: true });
  });

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fallback' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { fallback: true });
  } finally {
    await closeServer(server);
  }
});

test('codex oauth responses route can enable from config.env without process env restart', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oauth-route-'));
  await fs.writeFile(path.join(tempDir, 'config.env'), [
    'VCP_RESPONSES_PROVIDER=codex_oauth',
    'VCP_CODEX_OAUTH_ACCOUNT_ID=codex_from_config',
    'VCP_CODEX_OAUTH_UPSTREAM_BASE_URL=https://codex.example/backend',
    'VCP_CODEX_OAUTH_CLIENT_VERSION=9.9.9',
    '',
  ].join('\n'));

  const previousProvider = process.env.VCP_RESPONSES_PROVIDER;
  delete process.env.VCP_RESPONSES_PROVIDER;

  let called = false;
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    projectBasePath: tempDir,
    codexOAuthProvider: {
      async forwardResponses(body) {
        called = true;
        assert.equal(body.model, 'gpt-5.4-mini');
        return jsonResponse({ ok: true });
      },
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini' }),
    });
    const payload = await response.json();

    assert.equal(called, true);
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true });
  } finally {
    await closeServer(server);
    if (previousProvider === undefined) {
      delete process.env.VCP_RESPONSES_PROVIDER;
    } else {
      process.env.VCP_RESPONSES_PROVIDER = previousProvider;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('codex oauth responses route threads config.env timeout into provider', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oauth-timeout-'));
  await fs.writeFile(path.join(tempDir, 'config.env'), [
    'VCP_RESPONSES_PROVIDER=codex_oauth',
    'VCP_CODEX_OAUTH_ACCOUNT_ID=codex_from_config',
    'VCP_CODEX_OAUTH_UPSTREAM_BASE_URL=https://codex.example/backend',
    'VCP_CODEX_OAUTH_CLIENT_VERSION=9.9.9',
    'VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS=7777',
    '',
  ].join('\n'));

  const previousEnv = {
    VCP_RESPONSES_PROVIDER: process.env.VCP_RESPONSES_PROVIDER,
    VCP_CODEX_OAUTH_ACCOUNT_ID: process.env.VCP_CODEX_OAUTH_ACCOUNT_ID,
    VCP_CODEX_OAUTH_UPSTREAM_BASE_URL: process.env.VCP_CODEX_OAUTH_UPSTREAM_BASE_URL,
    VCP_CODEX_OAUTH_CLIENT_VERSION: process.env.VCP_CODEX_OAUTH_CLIENT_VERSION,
    VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS: process.env.VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS,
  };
  for (const key of Object.keys(previousEnv)) {
    delete process.env[key];
  }

  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(createCodexOAuthResponsesRouter({
    projectBasePath: tempDir,
    oauthAuthManager: {
      async getValidToken(provider, accountId) {
        assert.equal(provider, 'codex_oauth');
        assert.equal(accountId, 'codex_from_config');
        return {
          accessToken: 'access-token-secret',
          account: { metadata: { chatgptAccountId: 'chatgpt-account-1' } },
        };
      },
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  }));

  const { server, baseUrl } = await startServer(app);
  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4-mini' }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://codex.example/backend/responses');
    assert.equal(calls[0].options.signal instanceof AbortSignal, true);
    assert.equal(calls[0].options.signal.aborted, false);
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function startServer(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
