/**
 * MediaGateway Admin Routes
 * Responsibility: Admin API routes for media file management
 *
 * Route Prefix: /admin_api/mediaGateway
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

let mediaGateway = null;

function initialize(gateway) {
  mediaGateway = gateway;
}

function ensureGateway(req, res, next) {
  if (!mediaGateway) {
    return res.status(503).json({
      success: false,
      error: 'MediaGateway not initialized',
      timestamp: new Date().toISOString()
    });
  }
  next();
}

function ok(res, data = null, message = null) {
  const payload = {
    success: true,
    timestamp: new Date().toISOString()
  };
  if (data !== null) payload.data = data;
  if (message) payload.message = message;
  return res.status(200).json(payload);
}

function fail(res, error, statusCode = 500) {
  return res.status(statusCode).json({
    success: false,
    error: error?.message || error || 'Unknown error',
    timestamp: new Date().toISOString()
  });
}

const router = express.Router();
router.use(ensureGateway);

/**
 * GET /admin_api/mediaGateway/health
 * Health check for MediaGateway
 */
router.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      initialized: true,
      storagePath: mediaGateway.storagePath,
      mediaCount: mediaGateway.mediaIndex?.size || 0,
      timestamp: new Date().toISOString()
    };
    return ok(res, health);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/mediaGateway/media
 * List media files
 */
router.get('/media', async (req, res) => {
  try {
    const { adapterId, type, limit = 100, offset = 0 } = req.query;
    let mediaList = Array.from(mediaGateway.mediaIndex.values());

    if (adapterId) {
      mediaList = mediaList.filter(m => m.adapterId === adapterId);
    }
    if (type) {
      mediaList = mediaList.filter(m => m.mediaType === type);
    }

    const total = mediaList.length;
    const paginated = mediaList.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    return ok(res, paginated, null, {
      pagination: { total, limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/mediaGateway/media/:id
 * Get media details
 */
router.get('/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mediaInfo = mediaGateway.mediaIndex.get(id);

    if (!mediaInfo) {
      return fail(res, 'Media not found', 404);
    }

    return ok(res, mediaInfo);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * DELETE /admin_api/mediaGateway/media/:id
 * Delete media file
 */
router.delete('/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await mediaGateway.deleteMedia(id);

    if (!result) {
      return fail(res, 'Media not found', 404);
    }

    return ok(res, null, 'Media deleted successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/mediaGateway/media/:id/thumbnail
 * Generate thumbnail
 */
router.post('/media/:id/thumbnail', async (req, res) => {
  try {
    const { id } = req.params;
    const { width = 200, height = 200, quality = 80 } = req.body || {};

    const thumbnail = await mediaGateway.generateThumbnail(id, { width, height, quality });
    return ok(res, thumbnail, 'Thumbnail generated');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/mediaGateway/cache
 * Cache remote media
 */
router.post('/cache', async (req, res) => {
  try {
    const { url, adapterId, filename } = req.body || {};

    if (!url) {
      return fail(res, 'URL is required', 400);
    }

    const cached = await mediaGateway.cacheRemoteMedia(url, { adapterId, filename });
    return ok(res, cached, 'Remote media cached');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/mediaGateway/signed-url/:id
 * Get signed access URL
 */
router.get('/signed-url/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { expiresIn = 3600 } = req.query;

    const access = await mediaGateway.getSignedAccess(id, { expiresIn: parseInt(expiresIn) });
    return ok(res, access);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/mediaGateway/cleanup
 * Cleanup expired media files
 */
router.post('/cleanup', async (req, res) => {
  try {
    const { maxAge } = req.body || {};
    const result = await mediaGateway.cleanupExpiredMedia(maxAge);
    return ok(res, result, 'Cleanup completed');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/mediaGateway/stats
 * Get media statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const mediaList = Array.from(mediaGateway.mediaIndex.values());

    const stats = {
      total: mediaList.length,
      byType: {},
      byAdapter: {},
      totalSize: 0
    };

    for (const media of mediaList) {
      stats.byType[media.mediaType] = (stats.byType[media.mediaType] || 0) + 1;
      stats.byAdapter[media.adapterId] = (stats.byAdapter[media.adapterId] || 0) + 1;
      stats.totalSize += media.size || 0;
    }

    return ok(res, stats);
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = {
  router,
  initialize
};