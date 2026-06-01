'use strict';

const { createOAuthAuthManager } = require('../oauthAuthManager');

const DEFAULT_CODEX_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CODEX_CLIENT_VERSION = '1.0.0';

function sanitizeResponseBody(body = {}) {
  const nextBody = body && typeof body === 'object' ? { ...body } : {};
  nextBody.store = false;
  return nextBody;
}

class CodexOAuthProvider {
  constructor(options = {}) {
    this.oauthAuthManager = options.oauthAuthManager || createOAuthAuthManager({
      projectBasePath: options.projectBasePath,
    });
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.baseUrl = String(
      options.baseUrl ||
      process.env.VCP_CODEX_OAUTH_UPSTREAM_BASE_URL ||
      DEFAULT_CODEX_UPSTREAM_BASE_URL
    ).replace(/\/+$/, '');
    this.accountId = options.accountId || process.env.VCP_CODEX_OAUTH_ACCOUNT_ID || null;
    this.clientVersion = options.clientVersion || process.env.VCP_CODEX_OAUTH_CLIENT_VERSION || DEFAULT_CODEX_CLIENT_VERSION;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('CodexOAuthProvider requires fetch support.');
    }
  }

  async buildAuthHeaders() {
    const tokenResult = await this.oauthAuthManager.getValidToken('codex_oauth', this.accountId || null);
    const headers = {
      Authorization: `Bearer ${tokenResult.accessToken}`,
      'ChatGPT-Account-ID': tokenResult.account?.metadata?.chatgptAccountId || '',
      'User-Agent': 'VCPToolBox-CodexOAuthProvider/1.0',
      originator: 'codex_cli_rs',
    };

    if (!headers['ChatGPT-Account-ID']) {
      delete headers['ChatGPT-Account-ID'];
    }

    return headers;
  }

  async fetchModels() {
    const authHeaders = await this.buildAuthHeaders();
    return this.fetchImpl(`${this.baseUrl}/models?client_version=${encodeURIComponent(this.clientVersion)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders,
      },
    });
  }

  async forwardResponses(body = {}, requestHeaders = {}) {
    const stream = body.stream === true || String(requestHeaders.accept || '').includes('text/event-stream');
    const authHeaders = await this.buildAuthHeaders();
    const upstreamBody = sanitizeResponseBody({
      ...body,
      stream,
    });

    return this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(upstreamBody),
    });
  }
}

module.exports = {
  CodexOAuthProvider,
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_CODEX_UPSTREAM_BASE_URL,
  createCodexOAuthProvider: (options) => new CodexOAuthProvider(options),
};
