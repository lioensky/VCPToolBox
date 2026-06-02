'use strict';

const { createOAuthAuthManager } = require('../oauthAuthManager');

const DEFAULT_CODEX_UPSTREAM_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CODEX_CLIENT_VERSION = '1.0.0';
const DEFAULT_CODEX_UPSTREAM_TIMEOUT_MS = 120000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeResponseBody(body = {}) {
  const nextBody = body && typeof body === 'object' ? { ...body } : {};
  nextBody.store = false;
  return nextBody;
}

function wrapResponseBodyWithTimeout(response, timeoutMs, abortController) {
  if (!response?.body || typeof response.body.getReader !== 'function' || typeof ReadableStream !== 'function' || typeof Response !== 'function') {
    return response;
  }

  const reader = response.body.getReader();

  const body = new ReadableStream({
    async pull(controller) {
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);
      try {
        const { done, value } = await reader.read();
        clearTimeout(timeout);
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearTimeout(timeout);
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (typeof reader.cancel === 'function') {
        await reader.cancel(reason);
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
    this.timeoutMs = parsePositiveInteger(
      options.timeoutMs || process.env.VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS,
      DEFAULT_CODEX_UPSTREAM_TIMEOUT_MS
    );

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('CodexOAuthProvider requires fetch support.');
    }
  }

  async fetchWithTimeout(url, options = {}) {
    if (!this.timeoutMs || typeof AbortController !== 'function') {
      return this.fetchImpl(url, options);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return wrapResponseBodyWithTimeout(response, this.timeoutMs, controller);
    } catch (error) {
      clearTimeout(timeout);
      throw error;
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
    return this.fetchWithTimeout(`${this.baseUrl}/models?client_version=${encodeURIComponent(this.clientVersion)}`, {
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

    return this.fetchWithTimeout(`${this.baseUrl}/responses`, {
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
  DEFAULT_CODEX_UPSTREAM_TIMEOUT_MS,
  createCodexOAuthProvider: (options) => new CodexOAuthProvider(options),
};
