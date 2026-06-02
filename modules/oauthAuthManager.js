'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_GITHUB_COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23';
const OPENAI_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
const OPENAI_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const OPENAI_CODEX_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const GITHUB_DEVICE_VERIFICATION_URI = 'https://github.com/login/device';

const PROVIDERS = {
  codex_oauth: {
    id: 'codex_oauth',
    label: 'ChatGPT / Codex OAuth',
    supportsRefresh: true,
  },
  github_copilot: {
    id: 'github_copilot',
    label: 'GitHub Copilot OAuth',
    supportsRefresh: false,
  },
};

const SECRET_FIELD_NAMES = ['accessToken', 'refreshToken', 'idToken'];
const ENCRYPTED_SECRET_FORMAT = 'vcp-oauth-secret-v1';

class OAuthAuthError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'OAuthAuthError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function resolveTokenEncryptionKey(options = {}) {
  if (Buffer.isBuffer(options.tokenEncryptionKey)) {
    if (options.tokenEncryptionKey.length !== 32) {
      throw new OAuthAuthError('invalid_token_encryption_key', 'OAuth token encryption key buffer must be 32 bytes.', 500);
    }
    return Buffer.from(options.tokenEncryptionKey);
  }

  const value = options.tokenEncryptionKey || process.env.VCP_OAUTH_TOKEN_ENCRYPTION_KEY || '';
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  if (raw.toLowerCase().startsWith('base64:')) {
    const key = Buffer.from(raw.slice('base64:'.length), 'base64');
    if (key.length !== 32) {
      throw new OAuthAuthError('invalid_token_encryption_key', 'VCP_OAUTH_TOKEN_ENCRYPTION_KEY base64 value must decode to 32 bytes.', 500);
    }
    return key;
  }

  if (raw.toLowerCase().startsWith('hex:')) {
    const key = Buffer.from(raw.slice('hex:'.length), 'hex');
    if (key.length !== 32) {
      throw new OAuthAuthError('invalid_token_encryption_key', 'VCP_OAUTH_TOKEN_ENCRYPTION_KEY hex value must decode to 32 bytes.', 500);
    }
    return key;
  }

  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function requireTokenEncryptionKey(encryptionKey) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    throw new OAuthAuthError('token_encryption_key_missing', 'Set VCP_OAUTH_TOKEN_ENCRYPTION_KEY before storing OAuth token secrets.', 500);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function encryptSecretValue(value, encryptionKey) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  requireTokenEncryptionKey(encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: ENCRYPTED_SECRET_FORMAT,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecretValue(sealed, encryptionKey) {
  if (!sealed || typeof sealed !== 'object') {
    return '';
  }
  if (sealed.format !== ENCRYPTED_SECRET_FORMAT || sealed.alg !== 'aes-256-gcm') {
    throw new OAuthAuthError('unsupported_token_secret_format', 'OAuth token secret format is unsupported.', 500);
  }

  requireTokenEncryptionKey(encryptionKey);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(sealed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function getStoreAccounts(store) {
  const accounts = [];
  for (const provider of Object.values(store.providers || {})) {
    if (Array.isArray(provider && provider.accounts)) {
      accounts.push(...provider.accounts);
    }
  }
  return accounts;
}

function accountHasPlaintextSecret(account) {
  return SECRET_FIELD_NAMES.some((fieldName) => typeof account[fieldName] === 'string' && account[fieldName].length > 0);
}

function accountHasEncryptedSecret(account) {
  return SECRET_FIELD_NAMES.some((fieldName) => Boolean(account.encryptedSecrets && account.encryptedSecrets[fieldName]));
}

function restoreStoreSecrets(rawStore, encryptionKey) {
  const store = cloneJson(rawStore);
  for (const account of getStoreAccounts(store)) {
    if (!account || typeof account !== 'object') {
      continue;
    }

    if (accountHasEncryptedSecret(account)) {
      requireTokenEncryptionKey(encryptionKey);
      for (const fieldName of SECRET_FIELD_NAMES) {
        if (account.encryptedSecrets && account.encryptedSecrets[fieldName]) {
          account[fieldName] = decryptSecretValue(account.encryptedSecrets[fieldName], encryptionKey);
        }
      }
      delete account.encryptedSecrets;
    }

    if (accountHasPlaintextSecret(account)) {
      requireTokenEncryptionKey(encryptionKey);
    }
  }
  return store;
}

function prepareStoreForDisk(store, encryptionKey) {
  const diskStore = cloneJson(store);
  for (const account of getStoreAccounts(diskStore)) {
    if (!account || typeof account !== 'object') {
      continue;
    }

    const encryptedSecrets = { ...(account.encryptedSecrets || {}) };
    for (const fieldName of SECRET_FIELD_NAMES) {
      const value = account[fieldName];
      if (typeof value === 'string' && value.length > 0) {
        encryptedSecrets[fieldName] = encryptSecretValue(value, encryptionKey);
      }
      delete account[fieldName];
    }

    if (Object.keys(encryptedSecrets).length > 0) {
      account.encryptedSecrets = encryptedSecrets;
    } else {
      delete account.encryptedSecrets;
    }
  }
  return diskStore;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function createSessionId() {
  return crypto.randomUUID();
}

function createAccountId(prefix, seed) {
  const hash = crypto.createHash('sha256').update(String(seed || crypto.randomUUID())).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') {
    return {};
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_error) {
    return {};
  }
}

function extractOpenAiAccountId(claims) {
  if (!claims || typeof claims !== 'object') {
    return '';
  }

  const direct = claims.chatgpt_account_id;
  if (typeof direct === 'string' && direct) {
    return direct;
  }

  const urlScoped = claims['https://api.openai.com/auth.chatgpt_account_id'];
  if (typeof urlScoped === 'string' && urlScoped) {
    return urlScoped;
  }

  const authClaim = claims['https://api.openai.com/auth'];
  if (authClaim && typeof authClaim === 'object' && typeof authClaim.chatgpt_account_id === 'string') {
    return authClaim.chatgpt_account_id;
  }

  if (Array.isArray(claims.organizations) && claims.organizations.length > 0) {
    const firstOrg = claims.organizations.find((item) => item && typeof item.id === 'string' && item.id);
    if (firstOrg) {
      return firstOrg.id;
    }
  }

  return '';
}

function sanitizeAccount(account) {
  return {
    id: account.id,
    provider: account.provider,
    username: account.username || '',
    email: account.email || '',
    displayName: account.displayName || account.username || account.email || account.id,
    avatarUrl: account.avatarUrl || '',
    isDefault: Boolean(account.isDefault),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    tokenExpiresAt: account.tokenExpiresAt || null,
    hasRefreshToken: Boolean(account.refreshToken),
    hasAccessToken: Boolean(account.accessToken),
    metadata: account.metadata ? sanitizeMetadata(account.metadata) : {},
  };
}

function sanitizeMetadata(metadata) {
  const result = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/token|secret|credential|authorization/i.test(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function sanitizeUpstreamPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: typeof payload };
  }

  return {
    kind: 'object',
    keys: Object.keys(payload).slice(0, 20),
    error: typeof payload.error === 'string' ? payload.error : undefined,
    type: typeof payload.type === 'string' ? payload.type : undefined,
  };
}

function normalizeProvider(provider) {
  if (!PROVIDERS[provider]) {
    throw new OAuthAuthError('unsupported_provider', `Unsupported OAuth provider: ${provider}`, 400);
  }
  return provider;
}

async function safeReadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(tempPath, 0o600);
  } catch (_error) {}
  await fs.rename(tempPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch (_error) {}
}

async function parseHttpJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function createFetchError(provider, step, response, payload) {
  const message =
    typeof payload.error_description === 'string'
      ? payload.error_description
      : typeof payload.error === 'string'
        ? payload.error
        : `${provider} OAuth ${step} failed with HTTP ${response.status}`;
  return new OAuthAuthError('oauth_http_error', message, response.status, {
    provider,
    step,
    status: response.status,
    error: payload.error,
  });
}

class OAuthAuthManager {
  constructor(options = {}) {
    const projectBasePath = options.projectBasePath
      ? path.resolve(options.projectBasePath)
      : path.resolve(__dirname, '..');

    this.projectBasePath = projectBasePath;
    this.storagePath = path.resolve(
      options.storagePath || path.join(projectBasePath, 'state', 'oauth-auth', 'accounts.json')
    );
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.openBrowser = options.openBrowser || null;
    this.sessions = new Map();
    this.accessTokenCache = new Map();
    this.tokenEncryptionKey = resolveTokenEncryptionKey(options);
    this.openaiClientId = options.openaiClientId || process.env.VCP_OPENAI_CODEX_OAUTH_CLIENT_ID || DEFAULT_OPENAI_CLIENT_ID;
    this.githubCopilotClientId =
      options.githubCopilotClientId ||
      process.env.VCP_GITHUB_COPILOT_OAUTH_CLIENT_ID ||
      DEFAULT_GITHUB_COPILOT_CLIENT_ID;

    if (typeof this.fetchImpl !== 'function') {
      throw new OAuthAuthError('fetch_unavailable', 'OAuth auth manager requires fetch support.', 500);
    }
  }

  getProviderCatalog() {
    return Object.values(PROVIDERS);
  }

  async getStatus(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const accounts = await this.listAccounts(normalizedProvider);
    return {
      provider: normalizedProvider,
      authenticated: accounts.length > 0,
      defaultAccountId: accounts.find((account) => account.isDefault)?.id || null,
      accounts,
    };
  }

  async listAccounts(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const store = await this.loadStore();
    return this.getProviderAccounts(store, normalizedProvider).map(sanitizeAccount);
  }

  async startLogin(provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === 'codex_oauth') {
      return this.startOpenAiDeviceFlow();
    }
    return this.startGitHubCopilotDeviceFlow();
  }

  async pollForAccount(provider, sessionId) {
    const normalizedProvider = normalizeProvider(provider);
    const session = this.sessions.get(sessionId);
    if (!session || session.provider !== normalizedProvider) {
      throw new OAuthAuthError('session_not_found', 'OAuth login session was not found or has expired.', 404);
    }

    if (session.expiresAt <= nowMs()) {
      this.sessions.delete(sessionId);
      throw new OAuthAuthError('session_expired', 'OAuth login session has expired.', 410);
    }

    if (normalizedProvider === 'codex_oauth') {
      return this.pollOpenAiDeviceFlow(session);
    }
    return this.pollGitHubCopilotDeviceFlow(session);
  }

  async removeAccount(provider, accountId) {
    const normalizedProvider = normalizeProvider(provider);
    const store = await this.loadStore();
    const accounts = this.getProviderAccounts(store, normalizedProvider);
    const index = accounts.findIndex((account) => account.id === accountId);
    if (index < 0) {
      throw new OAuthAuthError('account_not_found', 'OAuth account was not found.', 404);
    }

    accounts.splice(index, 1);
    if (accounts.length > 0 && !accounts.some((account) => account.isDefault)) {
      accounts[0].isDefault = true;
      accounts[0].updatedAt = nowIso();
    }

    await this.saveStore(store);
    this.accessTokenCache.delete(`${normalizedProvider}:${accountId}`);
    return { success: true, accounts: accounts.map(sanitizeAccount) };
  }

  async setDefaultAccount(provider, accountId) {
    const normalizedProvider = normalizeProvider(provider);
    const store = await this.loadStore();
    const accounts = this.getProviderAccounts(store, normalizedProvider);
    if (!accounts.some((account) => account.id === accountId)) {
      throw new OAuthAuthError('account_not_found', 'OAuth account was not found.', 404);
    }

    const updatedAt = nowIso();
    for (const account of accounts) {
      account.isDefault = account.id === accountId;
      account.updatedAt = updatedAt;
    }

    await this.saveStore(store);
    return { success: true, accounts: accounts.map(sanitizeAccount) };
  }

  async logout(provider) {
    const normalizedProvider = normalizeProvider(provider);
    const store = await this.loadStore();
    store.providers[normalizedProvider] = { accounts: [] };
    await this.saveStore(store);

    for (const key of this.accessTokenCache.keys()) {
      if (key.startsWith(`${normalizedProvider}:`)) {
        this.accessTokenCache.delete(key);
      }
    }

    return { success: true };
  }

  async getValidToken(provider, accountId = null) {
    const normalizedProvider = normalizeProvider(provider);
    const store = await this.loadStore();
    const accounts = this.getProviderAccounts(store, normalizedProvider);
    const account =
      (accountId && accounts.find((item) => item.id === accountId)) ||
      accounts.find((item) => item.isDefault) ||
      accounts[0];

    if (!account) {
      throw new OAuthAuthError('account_not_found', 'No OAuth account is available for this provider.', 404);
    }

    if (normalizedProvider === 'codex_oauth') {
      return this.getValidOpenAiToken(store, account);
    }
    return this.getValidCopilotToken(account);
  }

  async smokeCodexUpstream(options = {}) {
    const tokenResult = await this.getValidToken('codex_oauth', options.accountId || null);
    const baseUrl = String(
      options.baseUrl ||
      process.env.VCP_CODEX_OAUTH_UPSTREAM_BASE_URL ||
      OPENAI_CODEX_UPSTREAM_BASE_URL
    ).replace(/\/+$/, '');
    const clientVersion = options.clientVersion || process.env.VCP_CODEX_OAUTH_CLIENT_VERSION || '1.0.0';
    const endpoint = `${baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`;
    const chatgptAccountId = tokenResult.account.metadata && tokenResult.account.metadata.chatgptAccountId;
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${tokenResult.accessToken}`,
      'Content-Type': 'application/json',
      originator: 'codex_cli_rs',
      'User-Agent': 'VCPToolBox-OAuthAuth/1.0',
    };

    if (chatgptAccountId) {
      headers['ChatGPT-Account-ID'] = chatgptAccountId;
    }

    const response = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers,
    });
    const payload = await parseHttpJson(response);

    return {
      provider: 'codex_oauth',
      account: tokenResult.account,
      tokenExpiresAt: tokenResult.expiresAt,
      upstream: {
        endpoint,
        status: response.status,
        ok: response.ok,
        contentType: typeof response.headers?.get === 'function' ? response.headers.get('content-type') || '' : '',
        payload: sanitizeUpstreamPayload(payload),
      },
    };
  }

  async startOpenAiDeviceFlow() {
    const payload = await this.postJson('https://auth.openai.com/api/accounts/deviceauth/usercode', {
      client_id: this.openaiClientId,
    }, 'codex_oauth', 'device_usercode');

    const deviceAuthId = payload.device_auth_id || payload.device_code;
    const userCode = payload.user_code;
    if (!deviceAuthId || !userCode) {
      throw new OAuthAuthError('invalid_device_response', 'OpenAI device auth response is missing required fields.', 502);
    }

    const sessionId = createSessionId();
    const intervalSeconds = parsePositiveInteger(payload.interval, 5);
    this.sessions.set(sessionId, {
      id: sessionId,
      provider: 'codex_oauth',
      deviceAuthId,
      userCode,
      intervalSeconds,
      expiresAt: nowMs() + parsePositiveInteger(payload.expires_in, 900) * 1000,
      createdAt: nowIso(),
    });

    return {
      sessionId,
      provider: 'codex_oauth',
      userCode,
      verificationUri: payload.verification_uri || payload.verification_url || OPENAI_DEVICE_VERIFICATION_URI,
      intervalSeconds,
      expiresInSeconds: parsePositiveInteger(payload.expires_in, 900),
    };
  }

  async pollOpenAiDeviceFlow(session) {
    const payload = await this.postJson(
      'https://auth.openai.com/api/accounts/deviceauth/token',
      {
        client_id: this.openaiClientId,
        device_auth_id: session.deviceAuthId,
        user_code: session.userCode,
      },
      'codex_oauth',
      'device_token',
      { allowPending: true }
    );

    if (isPendingDevicePayload(payload)) {
      return { status: 'pending', retryAfterSeconds: session.intervalSeconds };
    }

    const authorizationCode = payload.authorization_code || payload.code;
    const codeVerifier = payload.code_verifier || payload.verifier;
    if (!authorizationCode || !codeVerifier) {
      throw new OAuthAuthError('invalid_poll_response', 'OpenAI device auth poll response is missing authorization code fields.', 502, {
        keys: Object.keys(payload),
      });
    }

    const tokenPayload = await this.postForm(
      'https://auth.openai.com/oauth/token',
      {
        grant_type: 'authorization_code',
        client_id: this.openaiClientId,
        code: authorizationCode,
        redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
        code_verifier: codeVerifier,
      },
      'codex_oauth',
      'token_exchange'
    );

    const account = await this.saveOpenAiAccount(tokenPayload);
    this.sessions.delete(session.id);
    return { status: 'authenticated', account };
  }

  async startGitHubCopilotDeviceFlow() {
    const payload = await this.postForm(
      'https://github.com/login/device/code',
      {
        client_id: this.githubCopilotClientId,
        scope: 'read:user user:email copilot',
      },
      'github_copilot',
      'device_code',
      { acceptJson: true }
    );

    const deviceCode = payload.device_code;
    const userCode = payload.user_code;
    if (!deviceCode || !userCode) {
      throw new OAuthAuthError('invalid_device_response', 'GitHub device auth response is missing required fields.', 502);
    }

    const sessionId = createSessionId();
    const intervalSeconds = parsePositiveInteger(payload.interval, 5);
    this.sessions.set(sessionId, {
      id: sessionId,
      provider: 'github_copilot',
      deviceCode,
      intervalSeconds,
      expiresAt: nowMs() + parsePositiveInteger(payload.expires_in, 900) * 1000,
      createdAt: nowIso(),
    });

    return {
      sessionId,
      provider: 'github_copilot',
      userCode,
      verificationUri: payload.verification_uri || GITHUB_DEVICE_VERIFICATION_URI,
      intervalSeconds,
      expiresInSeconds: parsePositiveInteger(payload.expires_in, 900),
    };
  }

  async pollGitHubCopilotDeviceFlow(session) {
    const payload = await this.postForm(
      'https://github.com/login/oauth/access_token',
      {
        client_id: this.githubCopilotClientId,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      'github_copilot',
      'device_token',
      { acceptJson: true, allowPending: true }
    );

    if (isPendingDevicePayload(payload)) {
      return { status: 'pending', retryAfterSeconds: session.intervalSeconds };
    }

    if (!payload.access_token) {
      throw new OAuthAuthError('invalid_poll_response', 'GitHub device auth poll response is missing access_token.', 502, {
        error: payload.error,
      });
    }

    const user = await this.githubGet('https://api.github.com/user', payload.access_token, 'github_user');
    const emails = await this.githubGet('https://api.github.com/user/emails', payload.access_token, 'github_emails', {
      optional: true,
      fallback: [],
    });
    const copilotToken = await this.fetchCopilotApiToken(payload.access_token);
    const account = await this.saveGitHubCopilotAccount({
      githubToken: payload.access_token,
      scope: payload.scope || '',
      user,
      emails: Array.isArray(emails) ? emails : [],
      copilotToken,
    });

    this.sessions.delete(session.id);
    return { status: 'authenticated', account };
  }

  async saveOpenAiAccount(tokenPayload) {
    if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
      throw new OAuthAuthError('invalid_token_response', 'OpenAI token response is missing access_token or refresh_token.', 502);
    }

    const accessClaims = decodeJwtPayload(tokenPayload.access_token);
    const idClaims = decodeJwtPayload(tokenPayload.id_token);
    const accountSeed =
      extractOpenAiAccountId(idClaims) ||
      extractOpenAiAccountId(accessClaims) ||
      idClaims.email ||
      idClaims.sub ||
      tokenPayload.access_token;
    const accountId = createAccountId('codex', accountSeed);
    const expiresInSeconds = parsePositiveInteger(tokenPayload.expires_in, 3600);

    const account = {
      id: accountId,
      provider: 'codex_oauth',
      username: idClaims.name || idClaims.email || accountId,
      email: idClaims.email || '',
      displayName: idClaims.name || idClaims.email || accountId,
      avatarUrl: idClaims.picture || '',
      accessToken: '',
      refreshToken: tokenPayload.refresh_token,
      idToken: tokenPayload.id_token || '',
      tokenExpiresAt: new Date(nowMs() + expiresInSeconds * 1000).toISOString(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: {
        chatgptAccountId: extractOpenAiAccountId(idClaims) || extractOpenAiAccountId(accessClaims),
        scope: tokenPayload.scope || '',
        tokenType: tokenPayload.token_type || 'Bearer',
      },
    };

    this.accessTokenCache.set(`codex_oauth:${accountId}`, {
      token: tokenPayload.access_token,
      expiresAt: new Date(account.tokenExpiresAt).getTime(),
    });

    return this.upsertAccount(account);
  }

  async saveGitHubCopilotAccount({ githubToken, scope, user, emails, copilotToken }) {
    const primaryEmail =
      emails.find((item) => item && item.primary && item.verified && item.email)?.email ||
      emails.find((item) => item && item.email)?.email ||
      '';
    const accountId = createAccountId('copilot', user.id || user.login || githubToken);
    const account = {
      id: accountId,
      provider: 'github_copilot',
      username: user.login || accountId,
      email: primaryEmail,
      displayName: user.name || user.login || accountId,
      avatarUrl: user.avatar_url || '',
      accessToken: githubToken,
      refreshToken: '',
      tokenExpiresAt: copilotToken.expires_at ? new Date(copilotToken.expires_at * 1000).toISOString() : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: {
        githubUserId: user.id || null,
        scope,
        copilotApiBaseUrl: copilotToken.endpoints && copilotToken.endpoints.api ? copilotToken.endpoints.api : 'https://api.githubcopilot.com',
      },
    };

    this.accessTokenCache.set(`github_copilot:${accountId}`, {
      token: copilotToken.token,
      expiresAt: copilotToken.expires_at ? copilotToken.expires_at * 1000 : nowMs() + 25 * 60 * 1000,
      metadata: account.metadata,
    });

    return this.upsertAccount(account);
  }

  async upsertAccount(account) {
    const store = await this.loadStore();
    const accounts = this.getProviderAccounts(store, account.provider);
    const existingIndex = accounts.findIndex((item) => item.id === account.id);
    const createdAt = existingIndex >= 0 ? accounts[existingIndex].createdAt : account.createdAt;
    const isDefault = existingIndex >= 0 ? accounts[existingIndex].isDefault : accounts.length === 0;
    const nextAccount = {
      ...account,
      createdAt,
      isDefault,
      updatedAt: nowIso(),
    };

    if (existingIndex >= 0) {
      accounts[existingIndex] = nextAccount;
    } else {
      accounts.push(nextAccount);
    }

    if (!accounts.some((item) => item.isDefault)) {
      nextAccount.isDefault = true;
    }

    await this.saveStore(store);
    return sanitizeAccount(nextAccount);
  }

  async getValidOpenAiToken(store, account) {
    const cacheKey = `codex_oauth:${account.id}`;
    const cached = this.accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - nowMs() > 60 * 1000) {
      return {
        provider: 'codex_oauth',
        account: sanitizeAccount(account),
        accessToken: cached.token,
        expiresAt: new Date(cached.expiresAt).toISOString(),
      };
    }

    if (account.accessToken && account.tokenExpiresAt && new Date(account.tokenExpiresAt).getTime() - nowMs() > 60 * 1000) {
      return {
        provider: 'codex_oauth',
        account: sanitizeAccount(account),
        accessToken: account.accessToken,
        expiresAt: account.tokenExpiresAt,
      };
    }

    if (!account.refreshToken) {
      throw new OAuthAuthError('refresh_token_missing', 'OpenAI account does not have a refresh token.', 409);
    }

    const tokenPayload = await this.postForm(
      'https://auth.openai.com/oauth/token',
      {
        grant_type: 'refresh_token',
        client_id: this.openaiClientId,
        refresh_token: account.refreshToken,
        scope: 'openid profile email',
      },
      'codex_oauth',
      'token_refresh'
    );

    const expiresInSeconds = parsePositiveInteger(tokenPayload.expires_in, 3600);
    const accessToken = tokenPayload.access_token;
    account.accessToken = '';
    account.refreshToken = tokenPayload.refresh_token || account.refreshToken;
    account.idToken = tokenPayload.id_token || account.idToken || '';
    account.tokenExpiresAt = new Date(nowMs() + expiresInSeconds * 1000).toISOString();
    account.updatedAt = nowIso();
    await this.saveStore(store);

    this.accessTokenCache.set(cacheKey, {
      token: accessToken,
      expiresAt: new Date(account.tokenExpiresAt).getTime(),
    });

    return {
      provider: 'codex_oauth',
      account: sanitizeAccount(account),
      accessToken,
      expiresAt: account.tokenExpiresAt,
    };
  }

  async getValidCopilotToken(account) {
    const cacheKey = `github_copilot:${account.id}`;
    const cached = this.accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt - nowMs() > 60 * 1000) {
      return {
        provider: 'github_copilot',
        account: sanitizeAccount(account),
        accessToken: cached.token,
        expiresAt: new Date(cached.expiresAt).toISOString(),
        metadata: cached.metadata || account.metadata || {},
      };
    }

    if (!account.accessToken) {
      throw new OAuthAuthError('github_token_missing', 'GitHub Copilot account does not have a GitHub OAuth token.', 409);
    }

    const copilotToken = await this.fetchCopilotApiToken(account.accessToken);
    const expiresAt = copilotToken.expires_at ? copilotToken.expires_at * 1000 : nowMs() + 25 * 60 * 1000;
    const metadata = {
      ...(account.metadata || {}),
      copilotApiBaseUrl: copilotToken.endpoints && copilotToken.endpoints.api ? copilotToken.endpoints.api : 'https://api.githubcopilot.com',
    };
    this.accessTokenCache.set(cacheKey, {
      token: copilotToken.token,
      expiresAt,
      metadata,
    });

    return {
      provider: 'github_copilot',
      account: sanitizeAccount(account),
      accessToken: copilotToken.token,
      expiresAt: new Date(expiresAt).toISOString(),
      metadata,
    };
  }

  async fetchCopilotApiToken(githubToken) {
    const payload = await this.githubGet(
      'https://api.github.com/copilot_internal/v2/token',
      githubToken,
      'copilot_token'
    );

    if (!payload.token) {
      throw new OAuthAuthError('invalid_copilot_token_response', 'GitHub Copilot token response is missing token.', 502);
    }

    return payload;
  }

  async postJson(url, body, provider, step, options = {}) {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'VCPToolBox-OAuthAuth/1.0',
      },
      body: JSON.stringify(body),
    });
    const payload = await parseHttpJson(response);

    if (!response.ok) {
      if (options.allowPending && isPendingDevicePayload(payload)) {
        return payload;
      }
      throw createFetchError(provider, step, response, payload);
    }

    return payload;
  }

  async postForm(url, body, provider, step, options = {}) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'VCPToolBox-OAuthAuth/1.0',
    };
    if (options.acceptJson) {
      headers.Accept = 'application/json';
    }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body).toString(),
    });
    const payload = await parseHttpJson(response);

    if (!response.ok) {
      if (options.allowPending && isPendingDevicePayload(payload)) {
        return payload;
      }
      throw createFetchError(provider, step, response, payload);
    }

    if (options.allowPending && isPendingDevicePayload(payload)) {
      return payload;
    }

    return payload;
  }

  async githubGet(url, token, step, options = {}) {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'VCPToolBox-OAuthAuth/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const payload = await parseHttpJson(response);

    if (!response.ok) {
      if (options.optional) {
        return options.fallback;
      }
      throw createFetchError('github_copilot', step, response, payload);
    }

    return payload;
  }

  async loadStore() {
    const store = restoreStoreSecrets(await safeReadJson(this.storagePath, {
      version: 1,
      providers: {},
    }), this.tokenEncryptionKey);
    if (!store.providers || typeof store.providers !== 'object') {
      store.providers = {};
    }
    return store;
  }

  async saveStore(store) {
    store.version = 1;
    store.updatedAt = nowIso();
    await writeJsonAtomic(this.storagePath, prepareStoreForDisk(store, this.tokenEncryptionKey));
  }

  getProviderAccounts(store, provider) {
    normalizeProvider(provider);
    if (!store.providers[provider] || typeof store.providers[provider] !== 'object') {
      store.providers[provider] = { accounts: [] };
    }
    if (!Array.isArray(store.providers[provider].accounts)) {
      store.providers[provider].accounts = [];
    }
    return store.providers[provider].accounts;
  }
}

function isPendingDevicePayload(payload) {
  const nestedError = payload && payload.error && typeof payload.error === 'object'
    ? payload.error
    : {};
  return payload && (
    payload.error === 'authorization_pending' ||
    payload.error === 'slow_down' ||
    nestedError.code === 'deviceauth_authorization_pending' ||
    nestedError.code === 'authorization_pending' ||
    nestedError.code === 'slow_down' ||
    payload.status === 'pending'
  );
}

module.exports = {
  OAuthAuthError,
  OAuthAuthManager,
  PROVIDERS,
  createOAuthAuthManager: (options) => new OAuthAuthManager(options),
};
