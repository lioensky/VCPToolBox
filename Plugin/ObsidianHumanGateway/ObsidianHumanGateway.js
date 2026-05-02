const crypto = require('crypto');

const pending = new Map();

function nowIso() {
  return new Date().toISOString();
}

function toTtl(pluginConfig = {}) {
  const value = Number(pluginConfig.OBSIDIAN_CONFIRMATION_TTL_MS || process.env.OBSIDIAN_CONFIRMATION_TTL_MS || 900000);
  return Number.isFinite(value) && value > 0 ? value : 900000;
}

function pruneExpired(ttlMs) {
  const now = Date.now();
  for (const [id, request] of pending.entries()) {
    if (now - request.createdAtMs > ttlMs) {
      pending.set(id, {
        ...request,
        status: 'expired',
        resolvedAt: nowIso()
      });
    }
  }
}

function createRequest(payload = {}, pluginConfig = {}) {
  const ttlMs = toTtl(pluginConfig);
  pruneExpired(ttlMs);

  const id = `obsidian-confirm-${crypto.randomUUID()}`;
  const request = {
    id,
    status: 'pending',
    title: payload.title || 'Confirm Obsidian action',
    message: payload.message || 'Please confirm this Obsidian action.',
    riskLevel: payload.riskLevel || 'medium',
    action: payload.action || null,
    target: payload.target || null,
    details: payload.details || {},
    createdAt: nowIso(),
    createdAtMs: Date.now(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };

  pending.set(id, request);
  return request;
}

function resolveRequest(id, approved, reason = '') {
  const request = pending.get(id);
  if (!request) {
    const error = new Error(`Confirmation request not found: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  if (request.status !== 'pending') {
    return request;
  }

  const next = {
    ...request,
    status: approved ? 'approved' : 'rejected',
    reason,
    resolvedAt: nowIso()
  };
  pending.set(id, next);
  return next;
}

function registerRoutes(app, pluginConfig = {}) {
  app.post('/api/obsidian-human/confirm', (req, res) => {
    try {
      const request = createRequest(req.body || {}, pluginConfig);
      res.json({ status: 'success', request });
    } catch (error) {
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  app.get('/api/obsidian-human/pending/:id', (req, res) => {
    const ttlMs = toTtl(pluginConfig);
    pruneExpired(ttlMs);
    const request = pending.get(req.params.id);
    if (!request) {
      res.status(404).json({ status: 'error', error: 'Confirmation request not found.' });
      return;
    }
    res.json({ status: 'success', request });
  });

  app.post('/api/obsidian-human/resolve/:id', (req, res) => {
    try {
      const body = req.body || {};
      const request = resolveRequest(req.params.id, Boolean(body.approved), body.reason || '');
      res.json({ status: 'success', request });
    } catch (error) {
      res.status(error.statusCode || 500).json({ status: 'error', error: error.message });
    }
  });
}

async function processToolCall(args = {}) {
  const request = createRequest(args);
  return {
    content: [
      {
        type: 'text',
        text: `Confirmation request created: ${request.id}`
      }
    ],
    details: request
  };
}

function cleanup() {
  pending.clear();
}

module.exports = {
  registerRoutes,
  processToolCall,
  cleanup
};
