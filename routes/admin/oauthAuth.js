'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { parseEnvCascade } = require('../../envLoader');
const {
  OAuthAuthError,
  createOAuthAuthManager,
} = require('../../modules/oauthAuthManager');

module.exports = function createOAuthAuthAdminRoute(options = {}) {
  const router = express.Router();
  const enabled = options.enabled === true ||
    (options.enabled !== false && isTruthyFlag(process.env.VCP_OAUTH_AUTH_CENTER_ENABLED));

  if (!enabled) {
    router.use('/oauth-auth', (_req, res) => {
      res.status(404).json({
        success: false,
        error: 'oauth_auth_center_disabled',
        message: 'OAuth Auth Center is disabled. Set VCP_OAUTH_AUTH_CENTER_ENABLED=true to enable it.',
      });
    });
    return router;
  }

  const manager = options.oauthAuthManager || createOAuthAuthManager({
    projectBasePath: options.projectBasePath,
  });

  router.get('/oauth-auth/providers', (_req, res) => {
    res.json({ success: true, providers: manager.getProviderCatalog() });
  });

  router.get('/oauth-auth/:provider/status', async (req, res) => {
    try {
      const status = await manager.getStatus(req.params.provider);
      res.json({ success: true, status });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/oauth-auth/:provider/accounts', async (req, res) => {
    try {
      const accounts = await manager.listAccounts(req.params.provider);
      res.json({ success: true, accounts });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/:provider/login/start', async (req, res) => {
    try {
      const login = await manager.startLogin(req.params.provider);
      res.status(201).json({ success: true, login });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/:provider/login/poll', async (req, res) => {
    try {
      const sessionId = req.body && req.body.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'invalid_session_id',
          message: 'sessionId is required.',
        });
      }

      const result = await manager.pollForAccount(req.params.provider, sessionId);
      res.json({ success: true, result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/:provider/accounts/:accountId/default', async (req, res) => {
    try {
      const result = await manager.setDefaultAccount(req.params.provider, req.params.accountId);
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/:provider/upstream-smoke', async (req, res) => {
    try {
      if (req.params.provider !== 'codex_oauth') {
        return res.status(400).json({
          success: false,
          error: 'unsupported_smoke_provider',
          message: 'Upstream OAuth smoke is currently only supported for codex_oauth.',
        });
      }

      const accountId = req.body && typeof req.body.accountId === 'string' ? req.body.accountId : null;
      const smoke = await manager.smokeCodexUpstream({ accountId });
      res.status(smoke.upstream.ok ? 200 : 502).json({
        success: smoke.upstream.ok,
        smoke,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/oauth-auth/codex_oauth/responses-provider/status', async (_req, res) => {
    try {
      const config = await readResponsesProviderConfig(options);
      const status = await manager.getStatus('codex_oauth');
      res.json({
        success: true,
        provider: {
          enabled: String(config.VCP_RESPONSES_PROVIDER || '').trim().toLowerCase() === 'codex_oauth',
          configuredProvider: config.VCP_RESPONSES_PROVIDER || '',
          accountId: config.VCP_CODEX_OAUTH_ACCOUNT_ID || '',
          upstreamBaseUrl: config.VCP_CODEX_OAUTH_UPSTREAM_BASE_URL || '',
          clientVersion: config.VCP_CODEX_OAUTH_CLIENT_VERSION || '',
          authenticated: status.authenticated,
          defaultAccountId: status.defaultAccountId || null,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/codex_oauth/responses-provider/enable', async (req, res) => {
    try {
      const status = await manager.getStatus('codex_oauth');
      if (!status.authenticated) {
        return res.status(400).json({
          success: false,
          error: 'codex_oauth_not_authenticated',
          message: 'Authorize a Codex OAuth account before enabling the Responses provider.',
        });
      }

      const requestedAccountId = req.body && typeof req.body.accountId === 'string'
        ? req.body.accountId.trim()
        : '';
      const accountId = requestedAccountId || status.defaultAccountId || '';
      await updateMainConfig(options, {
        VCP_RESPONSES_PROVIDER: 'codex_oauth',
        VCP_CODEX_OAUTH_ACCOUNT_ID: accountId,
      });

      res.json({
        success: true,
        provider: {
          enabled: true,
          configuredProvider: 'codex_oauth',
          accountId,
          authenticated: true,
          defaultAccountId: status.defaultAccountId || null,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/codex_oauth/responses-provider/disable', async (_req, res) => {
    try {
      const status = await manager.getStatus('codex_oauth');
      await updateMainConfig(options, {
        VCP_RESPONSES_PROVIDER: '',
      });

      res.json({
        success: true,
        provider: {
          enabled: false,
          configuredProvider: '',
          accountId: '',
          authenticated: status.authenticated,
          defaultAccountId: status.defaultAccountId || null,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/oauth-auth/:provider/accounts/:accountId', async (req, res) => {
    try {
      const result = await manager.removeAccount(req.params.provider, req.params.accountId);
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/oauth-auth/:provider/logout', async (req, res) => {
    try {
      const result = await manager.logout(req.params.provider);
      res.json({ success: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
};

function isTruthyFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolveProjectBasePath(options = {}) {
  return options.projectBasePath || path.join(__dirname, '..', '..');
}

function resolveMainConfigPath(options = {}) {
  return path.join(resolveProjectBasePath(options), 'config.env');
}

async function readResponsesProviderConfig(options = {}) {
  const { env } = parseEnvCascade(resolveMainConfigPath(options));
  return {
    ...process.env,
    ...env,
  };
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function upsertEnvAssignments(content, updates) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const pending = { ...updates };

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(pending, key)) return line;
    const value = pending[key];
    delete pending[key];
    return `${key}=${value}`;
  });

  const pendingKeys = Object.keys(pending);
  if (pendingKeys.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') {
      nextLines.push('');
    }
    nextLines.push('# -------------------------------------------------------------------');
    nextLines.push('# [Responses API Provider] Managed by OAuth Auth Center');
    nextLines.push('# -------------------------------------------------------------------');
    for (const key of pendingKeys) {
      nextLines.push(`${key}=${pending[key]}`);
    }
  }

  return nextLines.join('\n').replace(/\n*$/, '\n');
}

async function updateMainConfig(options = {}, updates = {}) {
  const configPath = resolveMainConfigPath(options);
  const content = await readTextIfExists(configPath);
  await fs.writeFile(configPath, upsertEnvAssignments(content, updates), 'utf8');
}

function sendError(res, error) {
  if (error instanceof OAuthAuthError) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.code,
      message: error.message,
      details: error.details,
    });
  }

  console.error('[OAuthAuthAdmin] Request failed:', error);
  return res.status(500).json({
    success: false,
    error: 'oauth_auth_route_failed',
    message: error instanceof Error ? error.message : String(error),
  });
}
