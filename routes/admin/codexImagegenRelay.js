'use strict';

const express = require('express');
const {
  CodexImagegenRelayError,
  createCodexImagegenRelayQueue,
} = require('../../modules/codexImagegenRelayQueue');

module.exports = function createCodexImagegenRelayAdminRoute(options = {}) {
  const router = express.Router();
  const queue = options.codexImagegenRelayQueue || createCodexImagegenRelayQueue({
    projectBasePath: options.projectBasePath,
    queueRoot: options.codexImagegenRelayQueueRoot,
  });

  router.post('/codex-imagegen/requests', async (req, res) => {
    try {
      const request = await queue.createRequest(req.body || {});
      res.status(201).json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/codex-imagegen/requests', async (req, res) => {
    try {
      const requests = await queue.listRequests({
        status: req.query.status,
        limit: req.query.limit,
      });
      res.json({ success: true, requests });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/codex-imagegen/requests/:id', async (req, res) => {
    try {
      const request = await queue.getRequest(req.params.id);
      res.json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/codex-imagegen/requests/:id/cancel', async (req, res) => {
    try {
      const request = await queue.cancelRequest(req.params.id, {
        reason: req.body && req.body.reason,
        cancelled_by: req.adminAuthUser || null,
      });
      res.json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/codex-imagegen/requests/:id/retry', async (req, res) => {
    try {
      const request = await queue.retryRequest(req.params.id);
      res.status(201).json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/codex-imagegen/requests/:id/mark-saved', async (req, res) => {
    try {
      const body = req.body || {};
      const request = await queue.markSaved(req.params.id, {
        local_files: body.local_files || body.localFiles || body.local_file || body.localFile,
      });
      res.json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/codex-imagegen/requests/:id/fail-stale-claim', async (req, res) => {
    try {
      const request = await queue.failStaleClaim(req.params.id, {
        message: req.body && req.body.message,
      });
      res.json({ success: true, request });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
};

function sendError(res, error) {
  if (error instanceof CodexImagegenRelayError) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.code,
      message: error.message,
      details: error.details || undefined,
    });
  }

  console.error('[CodexImagegenRelayAdmin] Request failed:', error);
  return res.status(500).json({
    success: false,
    error: 'codex_imagegen_relay_route_failed',
    message: error instanceof Error ? error.message : String(error),
  });
}

