const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { OAuthAuthError, OAuthAuthManager } = require('../modules/oauthAuthManager');
const createOAuthAuthAdminRoute = require('../routes/admin/oauthAuth');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createUnsignedJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

test('oauth auth manager completes codex device flow and returns sanitized accounts', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-test-'));
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return jsonResponse({
        device_auth_id: 'device-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.openai.com/codex/device',
        interval: 1,
        expires_in: 600,
      });
    }

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      return jsonResponse({
        authorization_code: 'auth-code-123',
        code_verifier: 'verifier-123',
      });
    }

    if (url === 'https://auth.openai.com/oauth/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
      return jsonResponse({
        access_token: createUnsignedJwt({
          chatgpt_account_id: 'chatgpt-account-1',
        }),
        refresh_token: 'refresh-token-secret',
        id_token: createUnsignedJwt({
          email: 'codex@example.test',
          name: 'Codex Test',
          picture: 'https://example.test/avatar.png',
        }),
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl,
      tokenEncryptionKey: 'unit-test-oauth-token-encryption-key',
    });
    const login = await manager.startLogin('codex_oauth');
    assert.equal(login.userCode, 'ABCD-EFGH');
    assert.equal(login.provider, 'codex_oauth');

    const poll = await manager.pollForAccount('codex_oauth', login.sessionId);
    assert.equal(poll.status, 'authenticated');
    assert.equal(poll.account.email, 'codex@example.test');
    assert.equal(poll.account.hasRefreshToken, true);
    assert.equal(poll.account.accessToken, undefined);
    assert.equal(poll.account.refreshToken, undefined);

    const accounts = await manager.listAccounts('codex_oauth');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].displayName, 'Codex Test');
    assert.equal(accounts[0].hasRefreshToken, true);
    assert.equal(accounts[0].refreshToken, undefined);

    const storagePath = path.join(tempBasePath, 'state', 'oauth-auth', 'accounts.json');
    const storedText = await fs.readFile(storagePath, 'utf8');
    assert.equal(storedText.includes('refresh-token-secret'), false);
    const stored = JSON.parse(storedText);
    assert.equal(stored.providers.codex_oauth.accounts[0].refreshToken, undefined);
    assert.equal(stored.providers.codex_oauth.accounts[0].accessToken, undefined);
    assert.equal(typeof stored.providers.codex_oauth.accounts[0].encryptedSecrets.refreshToken.ciphertext, 'string');
    assert.equal(calls.length, 3);
  } finally {
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth manager reports pending codex device authorization without saving account', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-pending-test-'));
  const fetchImpl = async (url) => {
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return jsonResponse({
        device_auth_id: 'device-456',
        user_code: 'WXYZ-1234',
        interval: 2,
        expires_in: 600,
      });
    }

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      return jsonResponse({ error: 'authorization_pending' }, 403);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl,
      tokenEncryptionKey: 'unit-test-oauth-token-encryption-key',
    });
    const login = await manager.startLogin('codex_oauth');
    const poll = await manager.pollForAccount('codex_oauth', login.sessionId);

    assert.equal(poll.status, 'pending');
    assert.equal(poll.retryAfterSeconds, 2);
    assert.deepEqual(await manager.listAccounts('codex_oauth'), []);
  } finally {
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth manager accepts nested OpenAI pending device authorization payload', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-nested-pending-test-'));
  const fetchImpl = async (url) => {
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
      return jsonResponse({
        device_auth_id: 'device-nested-pending',
        user_code: 'NEST-1234',
        interval: 3,
        expires_in: 600,
      });
    }

    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      return jsonResponse({
        error: {
          message: 'Device authorization is pending. Please try again.',
          type: 'invalid_request_error',
          code: 'deviceauth_authorization_pending',
        },
      }, 403);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl,
      tokenEncryptionKey: 'unit-test-oauth-token-encryption-key',
    });
    const login = await manager.startLogin('codex_oauth');
    const poll = await manager.pollForAccount('codex_oauth', login.sessionId);

    assert.equal(poll.status, 'pending');
    assert.equal(poll.retryAfterSeconds, 3);
    assert.deepEqual(await manager.listAccounts('codex_oauth'), []);
  } finally {
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth manager refuses to persist token secrets without encryption key', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-key-test-'));
  try {
    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    });

    await assert.rejects(
      () => manager.saveOpenAiAccount({
        access_token: createUnsignedJwt({ chatgpt_account_id: 'chatgpt-account-1' }),
        refresh_token: 'refresh-token-secret',
        id_token: createUnsignedJwt({ email: 'codex@example.test' }),
        expires_in: 3600,
      }),
      (error) => error && error.code === 'token_encryption_key_missing'
    );
  } finally {
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth manager accepts plain env encryption key for persisted secrets', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-env-key-test-'));
  const previousKey = process.env.VCP_OAUTH_TOKEN_ENCRYPTION_KEY;
  process.env.VCP_OAUTH_TOKEN_ENCRYPTION_KEY = 'my-local-vcp-oauth-password';

  try {
    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl: async () => {
        throw new Error('fetch should not be called');
      },
    });

    const account = await manager.saveOpenAiAccount({
      access_token: createUnsignedJwt({ chatgpt_account_id: 'chatgpt-account-1' }),
      refresh_token: 'refresh-token-secret',
      id_token: createUnsignedJwt({ email: 'codex@example.test' }),
      expires_in: 3600,
    });

    assert.equal(account.hasRefreshToken, true);
    const storagePath = path.join(tempBasePath, 'state', 'oauth-auth', 'accounts.json');
    const storedText = await fs.readFile(storagePath, 'utf8');
    assert.equal(storedText.includes('refresh-token-secret'), false);
    assert.equal(storedText.includes('id_token'), false);
    assert.equal(JSON.parse(storedText).providers.codex_oauth.accounts[0].encryptedSecrets.refreshToken.format, 'vcp-oauth-secret-v1');
  } finally {
    if (previousKey === undefined) {
      delete process.env.VCP_OAUTH_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.VCP_OAUTH_TOKEN_ENCRYPTION_KEY = previousKey;
    }
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth manager refreshes codex token in memory and smokes upstream without leaking token', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-oauth-auth-smoke-test-'));
  const storagePath = path.join(tempBasePath, 'state', 'oauth-auth', 'accounts.json');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url === 'https://auth.openai.com/oauth/token') {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-token-secret');
      return jsonResponse({
        access_token: createUnsignedJwt({ chatgpt_account_id: 'chatgpt-account-1' }),
        refresh_token: 'refresh-token-rotated',
        id_token: createUnsignedJwt({ email: 'codex@example.test' }),
        expires_in: 3600,
      });
    }

    if (url === 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0') {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, `Bearer ${createUnsignedJwt({ chatgpt_account_id: 'chatgpt-account-1' })}`);
      assert.equal(options.headers['ChatGPT-Account-ID'], 'chatgpt-account-1');
      assert.equal(options.headers.originator, 'codex_cli_rs');
      assert.equal(options.body, undefined);
      return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.3-codex' }] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, JSON.stringify({
      version: 1,
      providers: {
        codex_oauth: {
          accounts: [
            {
              id: 'codex_abc',
              provider: 'codex_oauth',
              username: 'Codex Test',
              email: 'codex@example.test',
              displayName: 'Codex Test',
              avatarUrl: '',
              accessToken: '',
              refreshToken: 'refresh-token-secret',
              idToken: '',
              tokenExpiresAt: '2000-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              isDefault: true,
              metadata: {
                chatgptAccountId: 'chatgpt-account-1',
              },
            },
          ],
        },
      },
    }, null, 2), 'utf8');

    const manager = new OAuthAuthManager({
      projectBasePath: tempBasePath,
      fetchImpl,
      tokenEncryptionKey: 'unit-test-oauth-token-encryption-key',
    });
    const smoke = await manager.smokeCodexUpstream();

    assert.equal(smoke.upstream.ok, true);
    assert.equal(smoke.account.refreshToken, undefined);
    assert.equal(smoke.account.accessToken, undefined);
    assert.equal(smoke.upstream.payload.keys.includes('data'), true);
    const storedText = await fs.readFile(storagePath, 'utf8');
    assert.equal(storedText.includes('refresh-token-secret'), false);
    assert.equal(storedText.includes('refresh-token-rotated'), false);
    const stored = JSON.parse(storedText);
    assert.equal(stored.providers.codex_oauth.accounts[0].refreshToken, undefined);
    assert.equal(stored.providers.codex_oauth.accounts[0].accessToken, undefined);
    assert.equal(typeof stored.providers.codex_oauth.accounts[0].encryptedSecrets.refreshToken.ciphertext, 'string');
    assert.equal(calls.length, 2);
  } finally {
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth admin route is disabled by default', async () => {
  let called = false;
  const app = express();
  app.use(express.json());
  app.use(createOAuthAuthAdminRoute({
    oauthAuthManager: {
      getProviderCatalog() {
        called = true;
        return [];
      },
    },
  }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/oauth-auth/providers`);
    const payload = await response.json();

    assert.equal(response.status, 404);
    assert.equal(payload.error, 'oauth_auth_center_disabled');
    assert.equal(called, false);
  } finally {
    await closeServer(server);
  }
});

test('oauth auth admin route exposes provider status and login lifecycle without leaking tokens', async () => {
  const manager = {
    getProviderCatalog() {
      return [
        { id: 'codex_oauth', label: 'ChatGPT / Codex OAuth', supportsRefresh: true },
      ];
    },
    async getStatus(provider) {
      assert.equal(provider, 'codex_oauth');
      return {
        provider,
        authenticated: true,
        defaultAccountId: 'codex_abc',
        accounts: [
          {
            id: 'codex_abc',
            provider,
            displayName: 'Codex Test',
            email: 'codex@example.test',
            isDefault: true,
            hasRefreshToken: true,
            hasAccessToken: false,
          },
        ],
      };
    },
    async startLogin(provider) {
      assert.equal(provider, 'codex_oauth');
      return {
        sessionId: 'session-1',
        provider,
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.com/codex/device',
        intervalSeconds: 1,
        expiresInSeconds: 600,
      };
    },
    async pollForAccount(provider, sessionId) {
      assert.equal(provider, 'codex_oauth');
      assert.equal(sessionId, 'session-1');
      return {
        status: 'authenticated',
        account: {
          id: 'codex_abc',
          provider,
          displayName: 'Codex Test',
          email: 'codex@example.test',
          isDefault: true,
          hasRefreshToken: true,
          hasAccessToken: false,
        },
      };
    },
    async setDefaultAccount(provider, accountId) {
      assert.equal(provider, 'codex_oauth');
      assert.equal(accountId, 'codex_abc');
      return {
        accounts: [
          {
            id: accountId,
            provider,
            displayName: 'Codex Test',
            isDefault: true,
            hasRefreshToken: true,
            hasAccessToken: false,
          },
        ],
      };
    },
    async smokeCodexUpstream({ accountId }) {
      assert.equal(accountId, null);
      return {
        provider: 'codex_oauth',
        account: {
          id: 'codex_abc',
          provider: 'codex_oauth',
          displayName: 'Codex Test',
          email: 'codex@example.test',
          hasRefreshToken: true,
          hasAccessToken: false,
        },
        tokenExpiresAt: '2026-01-01T01:00:00.000Z',
        upstream: {
          endpoint: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
          status: 200,
          ok: true,
          contentType: 'application/json',
          payload: { kind: 'object', keys: ['id', 'status'] },
        },
      };
    },
  };

  const { server, baseUrl } = await startRouteServer(manager);
  try {
    const providersResponse = await fetch(`${baseUrl}/oauth-auth/providers`);
    assert.equal(providersResponse.status, 200);
    const providers = await providersResponse.json();
    assert.equal(providers.providers[0].id, 'codex_oauth');

    const statusResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.status.defaultAccountId, 'codex_abc');
    assert.equal(status.status.accounts[0].refreshToken, undefined);

    const startResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/login/start`, { method: 'POST' });
    assert.equal(startResponse.status, 201);
    const start = await startResponse.json();
    assert.equal(start.login.userCode, 'ABCD-EFGH');

    const badPollResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/login/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badPollResponse.status, 400);
    const badPoll = await badPollResponse.json();
    assert.equal(badPoll.error, 'invalid_session_id');

    const pollResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/login/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    });
    assert.equal(pollResponse.status, 200);
    const poll = await pollResponse.json();
    assert.equal(poll.result.status, 'authenticated');
    assert.equal(poll.result.account.refreshToken, undefined);

    const defaultResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/accounts/codex_abc/default`, {
      method: 'POST',
    });
    assert.equal(defaultResponse.status, 200);
    const defaultPayload = await defaultResponse.json();
    assert.equal(defaultPayload.accounts[0].isDefault, true);

    const smokeResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/upstream-smoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(smokeResponse.status, 200);
    const smoke = await smokeResponse.json();
    assert.equal(smoke.success, true);
    assert.equal(smoke.smoke.upstream.ok, true);
    assert.equal(smoke.smoke.account.refreshToken, undefined);
    assert.equal(smoke.smoke.accessToken, undefined);
    assert.equal(smoke.smoke.upstream.payload.keys.includes('id'), true);
  } finally {
    await closeServer(server);
  }
});

test('oauth auth admin route manages codex responses provider config without tokens', async () => {
  const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-admin-provider-'));
  await fs.writeFile(path.join(tempBasePath, 'config.env'), [
    'PORT=6005',
    'VCP_RESPONSES_PROVIDER=',
    '',
  ].join('\n'), 'utf8');

  const manager = {
    getProviderCatalog() {
      return [];
    },
    async getStatus(provider) {
      assert.equal(provider, 'codex_oauth');
      return {
        provider,
        authenticated: true,
        defaultAccountId: 'codex_abc',
        accounts: [
          {
            id: 'codex_abc',
            provider,
            displayName: 'Codex Test',
            isDefault: true,
            hasRefreshToken: true,
            hasAccessToken: false,
          },
        ],
      };
    },
  };

  const { server, baseUrl } = await startRouteServer(manager, { projectBasePath: tempBasePath });
  try {
    const initialResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/responses-provider/status`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.provider.enabled, false);

    const enableResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/responses-provider/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'codex_abc' }),
    });
    assert.equal(enableResponse.status, 200);
    const enabled = await enableResponse.json();
    assert.equal(enabled.provider.enabled, true);
    assert.equal(enabled.provider.accountId, 'codex_abc');

    const enabledConfig = await fs.readFile(path.join(tempBasePath, 'config.env'), 'utf8');
    assert.match(enabledConfig, /^VCP_RESPONSES_PROVIDER=codex_oauth$/m);
    assert.match(enabledConfig, /^VCP_CODEX_OAUTH_ACCOUNT_ID=codex_abc$/m);
    assert.equal(enabledConfig.includes('refresh-token'), false);
    assert.equal(enabledConfig.includes('access-token'), false);

    const disableResponse = await fetch(`${baseUrl}/oauth-auth/codex_oauth/responses-provider/disable`, {
      method: 'POST',
    });
    assert.equal(disableResponse.status, 200);
    const disabled = await disableResponse.json();
    assert.equal(disabled.provider.enabled, false);

    const disabledConfig = await fs.readFile(path.join(tempBasePath, 'config.env'), 'utf8');
    assert.match(disabledConfig, /^VCP_RESPONSES_PROVIDER=$/m);
    assert.match(disabledConfig, /^VCP_CODEX_OAUTH_ACCOUNT_ID=codex_abc$/m);
  } finally {
    await closeServer(server);
    await fs.rm(tempBasePath, { recursive: true, force: true });
  }
});

test('oauth auth admin route maps manager errors to structured responses', async () => {
  const manager = {
    getProviderCatalog() {
      return [];
    },
    async getStatus() {
      throw new OAuthAuthError('unsupported_provider', 'Unsupported OAuth provider: bad', 400);
    },
  };

  const { server, baseUrl } = await startRouteServer(manager);
  try {
    const response = await fetch(`${baseUrl}/oauth-auth/bad/status`);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(payload.error, 'unsupported_provider');
  } finally {
    await closeServer(server);
  }
});

async function startRouteServer(manager, routeOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use(createOAuthAuthAdminRoute({ enabled: true, oauthAuthManager: manager, ...routeOptions }));

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
