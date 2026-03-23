/**
 * ChannelHub Admin Routes
 * Responsibility: Admin API routes for adapter management, monitoring, and configuration
 * 
 * Route Prefix: /admin_api/channelHub
 * 
 * Endpoints:
 *   GET    /adapters                  - List all adapters
 *   POST   /adapters                  - Create new adapter
 *   GET    /adapters/:id              - Get adapter details
 *   PUT    /adapters/:id              - Update adapter config
 *   DELETE /adapters/:id              - Delete adapter
 *   POST   /adapters/:id/enable       - Enable adapter
 *   POST   /adapters/:id/disable      - Disable adapter
 *   POST   /adapters/:id/test         - Test adapter connection
 *   
 *   GET    /bindings                  - List session bindings
 *   DELETE /bindings/:id              - Delete session binding
 *   
 *   GET    /outbox                    - List outbox jobs
 *   POST   /outbox/:id/retry          - Retry failed job
 *   DELETE /outbox/:id                - Cancel outbox job
 *   
 *   GET    /metrics                   - Get metrics summary
 *   GET    /health                    - Health check
 *   GET    /audit-logs                - Get audit logs
 */

const express = require('express');
const router = express.Router();

// Service instance (injected during initialization)
let channelHubService = null;

function getServiceModule(moduleName) {
  if (!channelHubService) return null;
  if (typeof channelHubService.getModule === 'function') {
    return channelHubService.getModule(moduleName);
  }
  return channelHubService[moduleName] || channelHubService.modules?.[moduleName] || null;
}

function ok(res, data = null, message = null, statusCode = 200, extra = {}) {
  const payload = {
    success: true,
    timestamp: new Date().toISOString(),
    ...extra
  };

  if (data !== null) payload.data = data;
  if (message) payload.message = message;

  return res.status(statusCode).json(payload);
}

function fail(res, error, statusCode = 500, extra = {}) {
  return res.status(statusCode).json({
    success: false,
    error: error?.message || error || 'Unknown error',
    timestamp: new Date().toISOString(),
    ...extra
  });
}

/**
 * Initialize admin routes with service instance
 * @param {ChannelHubService} service - ChannelHub service instance
 */
function initialize(service) {
  channelHubService = service;
}

// Helper to ensure service is initialized
function ensureService(req, res, next) {
  if (!channelHubService || !channelHubService.initialized) {
    return res.status(503).json({
      success: false,
      error: 'ChannelHub service not initialized',
      timestamp: new Date().toISOString()
    });
  }
  next();
}

// Apply service check to all routes
router.use(ensureService);

// ============================================================================
// Adapter Management Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/adapters
 * List all registered adapters
 */
router.get('/adapters', async (req, res) => {
  try {
    const registry = getServiceModule('adapterRegistry');
    const adapters = await registry.listAdapters();
    return ok(res, adapters);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/adapters
 * Create and register a new adapter
 */
router.post('/adapters', async (req, res) => {
  try {
    const adapterConfig = req.body;
    const registry = getServiceModule('adapterRegistry');
    
    // Validate required fields (support both adapterId and id for compatibility)
    const adapterId = adapterConfig.adapterId || adapterConfig.id;
    
    if (!adapterId) {
      return fail(res, 'Adapter ID is required (field: adapterId or id)', 400);
    }
    
    // Use upsertAdapter instead of register for consistency
    const adapter = await registry.upsertAdapter({
      adapterId,
      channel: adapterConfig.channel || 'unknown',
      name: adapterConfig.name || adapterId,
      config: adapterConfig.config || {},
      status: adapterConfig.status || 'inactive'
    });
    
    return ok(res, adapter, 'Adapter created successfully', 201);
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * GET /admin_api/channelHub/adapters/:id
 * Get specific adapter details
 */
router.get('/adapters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    const adapter = await registry.getAdapter(id);
    
    if (!adapter) {
      return fail(res, 'Adapter not found', 404);
    }
    
    return ok(res, adapter);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * PUT /admin_api/channelHub/adapters/:id
 * Update adapter configuration
 */
router.put('/adapters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const registry = getServiceModule('adapterRegistry');
    
    const existingAdapter = await registry.getAdapter(id);
    if (!existingAdapter) {
      return fail(res, 'Adapter not found', 404);
    }
    
    await registry.updateAdapter(id, updates);
    const adapter = await registry.getAdapter(id);
    
    return ok(res, adapter, 'Adapter updated successfully');
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * DELETE /admin_api/channelHub/adapters/:id
 * Delete/unregister an adapter
 */
router.delete('/adapters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    
    await registry.unregister(id);
    
    return ok(res, null, 'Adapter deleted successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/adapters/:id/enable
 * Enable an adapter
 */
router.post('/adapters/:id/enable', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    
    await registry.enableAdapter(id);
    
    return ok(res, null, 'Adapter enabled successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/adapters/:id/disable
 * Disable an adapter
 */
router.post('/adapters/:id/disable', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    
    await registry.disableAdapter(id);
    
    return ok(res, null, 'Adapter disabled successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/adapters/:id/test
 * Test adapter connection
 */
router.post('/adapters/:id/test', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    
    // Check if adapter exists
    const adapter = await registry.getAdapter(id);
    if (!adapter) {
      return fail(res, 'Adapter not found', 404);
    }
    
    // Try to get adapter instance and test connection
    const startTime = Date.now();
    let testResult = { success: true, latency: 0, message: 'Connection OK' };
    
    try {
      const adapterInstance = registry.getAdapterInstance(id);
      if (adapterInstance && typeof adapterInstance.testConnection === 'function') {
        testResult = await adapterInstance.testConnection();
      }
    } catch (testError) {
      testResult = { 
        success: false, 
        latency: Date.now() - startTime, 
        message: testError.message 
      };
    }
    
    testResult.latency = Date.now() - startTime;
    
    return ok(res, testResult);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/channelHub/adapters/:id/health
 * Get adapter health summary
 */
router.get('/adapters/:id/health', async (req, res) => {
  try {
    const { id } = req.params;
    const registry = getServiceModule('adapterRegistry');
    const adapter = await registry.getAdapter(id);

    if (!adapter) {
      return fail(res, 'Adapter not found', 404);
    }

    const health = {
      healthy: adapter.status === 'active',
      adapterId: adapter.adapterId,
      status: adapter.status,
      lastCheck: new Date().toISOString(),
      responseTime: 0,
      errorCount: 0,
      issues: adapter.status === 'error'
        ? [{ severity: 'error', message: 'Adapter status is error', timestamp: new Date().toISOString() }]
        : []
    };

    return ok(res, health);
  } catch (error) {
    return fail(res, error);
  }
});

// ============================================================================
// Session Binding Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/bindings
 * List session bindings with optional filters
 */
router.get('/bindings', async (req, res) => {
  try {
    const { adapterId, agentId, channel } = req.query;
    const bindingStore = getServiceModule('sessionBindingStore');
    
    const filters = {};
    if (adapterId) filters.adapterId = adapterId;
    if (agentId) filters.agentId = agentId;
    if (channel) filters.channel = channel;
    
    const bindings = await bindingStore.list(filters);
    return ok(res, bindings);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/bindings/by-external/:adapterId/:externalSessionKey', async (req, res) => {
  try {
    const { adapterId, externalSessionKey } = req.params;
    const bindingStore = getServiceModule('sessionBindingStore');

    const binding = await bindingStore.findByExternal(adapterId, externalSessionKey);
    if (!binding) {
      return fail(res, 'Binding not found', 404);
    }

    return ok(res, binding);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/channelHub/bindings/:id
 * Get specific session binding
 */
router.get('/bindings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bindingStore = getServiceModule('sessionBindingStore');
    
    const binding = await bindingStore.get(id);
    if (!binding) {
      return fail(res, 'Binding not found', 404);
    }
    
    return ok(res, binding);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/bindings
 * Create a session binding
 */
router.post('/bindings', async (req, res) => {
  try {
    const bindingStore = getServiceModule('sessionBindingStore');
    const binding = req.body || {};

    await bindingStore.bindSession({
      ...binding,
      isActive: binding.isActive !== false
    });

    const saved = await bindingStore.get(binding.bindingKey);

    return ok(res, saved, 'Binding created successfully', 201);
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * PUT /admin_api/channelHub/bindings/:id
 * Update a session binding
 */
router.put('/bindings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bindingStore = getServiceModule('sessionBindingStore');
    const updates = req.body || {};

    await bindingStore.rebindSession(id, updates);
    const saved = await bindingStore.get(id);

    return ok(res, saved, 'Binding updated successfully');
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * DELETE /admin_api/channelHub/bindings/:id
 * Delete a session binding
 */
router.delete('/bindings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const bindingStore = getServiceModule('sessionBindingStore');
    
    await bindingStore.delete(id);
    return ok(res, null, 'Binding deleted successfully');
  } catch (error) {
    return fail(res, error);
  }
});

// ============================================================================
// Outbox Management Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/outbox
 * List outbox jobs with optional status filter
 */
router.get('/outbox', async (req, res) => {
  try {
    const { status, adapterId, limit = 100, offset = 0 } = req.query;
    const outbox = getServiceModule('deliveryOutbox');
    
    const filters = {};
    if (status) filters.status = status;
    if (adapterId) filters.adapterId = adapterId;
    
    const jobs = await outbox.listJobs({
      ...filters,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    const total = await outbox.countJobs(filters);
    
    return ok(res, jobs, null, 200, {
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total
      }
    });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/channelHub/outbox/:id
 * Get specific outbox job
 */
router.get('/outbox/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const outbox = getServiceModule('deliveryOutbox');
    
    const job = await outbox.getJob(id);
    if (!job) {
      return fail(res, 'Job not found', 404);
    }
    
    return ok(res, job);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/outbox/:id/retry
 * Retry a failed outbox job
 */
router.post('/outbox/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;
    const outbox = getServiceModule('deliveryOutbox');
    
    await outbox.retryJob(id);
    return ok(res, null, 'Job queued for retry');
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/outbox/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const outbox = getServiceModule('deliveryOutbox');

    await outbox.cancelJob(id);
    return ok(res, null, 'Job cancelled successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * DELETE /admin_api/channelHub/outbox/:id
 * Cancel an outbox job
 */
router.delete('/outbox/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const outbox = getServiceModule('deliveryOutbox');
    
    await outbox.cancelJob(id);
    return ok(res, null, 'Job cancelled successfully');
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/channelHub/outbox/stats
 * Get outbox stats
 */
router.get('/outbox/stats', async (req, res) => {
  try {
    const outbox = getServiceModule('deliveryOutbox');
    const stats = outbox.getStats();

    return ok(res, {
      total: stats.total || 0,
      pending: stats.pending || 0,
      processing: stats.processing || 0,
      sent: stats.delivered || 0,
      failed: stats.failed || 0,
      deadLetter: stats.deadLetter || stats.failed || 0
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/outbox/dead-letters', async (req, res) => {
  try {
    const outbox = getServiceModule('deliveryOutbox');
    const deadLetters = await outbox.getDeadLetters({
      limit: parseInt(req.query.limit || 100, 10)
    });
    return ok(res, deadLetters);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/outbox/retry-batch', async (req, res) => {
  try {
    const outbox = getServiceModule('deliveryOutbox');
    const { ids = [] } = req.body || {};

    let retried = 0;
    for (const id of ids) {
      await outbox.retryJob(id);
      retried += 1;
    }

    return ok(res, { retried }, 'Batch retry queued');
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.post('/outbox/cleanup', async (req, res) => {
  try {
    const outbox = getServiceModule('deliveryOutbox');
    const { status = 'delivered', limit = 1000 } = req.body || {};
    const jobs = await outbox.listJobs({ status, limit });
    return ok(res, { removed: 0, inspected: jobs.length }, 'Cleanup is currently non-destructive');
  } catch (error) {
    return fail(res, error, 400);
  }
});

// ============================================================================
// Monitoring Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/metrics
 * Get aggregated metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const { period = '1h', adapterId } = req.query;
    const metricsCollector = getServiceModule('metricsCollector');
    const adapterRegistry = getServiceModule('adapterRegistry');
    
    // Get metrics snapshot
    const snapshot = metricsCollector.snapshot();
    const adapters = await adapterRegistry.listAdapters();
    const channels = [...new Set(adapters.map((adapter) => adapter.channel).filter(Boolean))];
    
    // Build response with period-based aggregation
    const metrics = {
      period,
      eventsReceived: snapshot['inbound.events.total'] || 0,
      eventsProcessed: snapshot['inbound.events.success'] || 0,
      eventsFailed: snapshot['inbound.events.error'] || 0,
      eventsDuplicate: snapshot['inbound.events.duplicate'] || 0,
      avgProcessingTimeMs: snapshot['inbound.events.duration'] || 0,
      outboundJobsTotal: snapshot['outbound.jobs.total'] || 0,
      outboundJobsSuccess: snapshot['outbound.jobs.success'] || 0,
      outboundJobsFailed: snapshot['outbound.jobs.error'] || 0,
      activeAdapters: adapters.filter((adapter) => adapter.status === 'active').length,
      byChannel: Object.fromEntries(channels.map((channel) => [channel, {
        eventsReceived: 0,
        eventsProcessed: 0,
        eventsFailed: 0,
        avgLatencyMs: 0
      }])),
      byEventType: {}
    };
    
    // If adapterId specified, filter metrics
    if (adapterId) {
      metrics.adapterId = adapterId;
    }
    
    return ok(res, metrics);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/summary', async (req, res) => {
  try {
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, snapshot);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/realtime', async (req, res) => {
  try {
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, {
      generatedAt: new Date().toISOString(),
      snapshot
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/channel/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, {
      channel,
      snapshot
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/adapter/:adapterId', async (req, res) => {
  try {
    const { adapterId } = req.params;
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, {
      adapterId,
      snapshot
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/events/distribution', async (req, res) => {
  try {
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, {
      duplicate: snapshot['inbound.events.duplicate'] || 0,
      success: snapshot['inbound.events.success'] || 0,
      error: snapshot['inbound.events.error'] || 0,
      total: snapshot['inbound.events.total'] || 0
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/metrics/errors', async (req, res) => {
  try {
    const metricsCollector = getServiceModule('metricsCollector');
    const snapshot = metricsCollector.snapshot();
    return ok(res, {
      outbound: snapshot['outbound.jobs.error'] || 0,
      inbound: snapshot['inbound.events.error'] || 0,
      total: (snapshot['outbound.jobs.error'] || 0) + (snapshot['inbound.events.error'] || 0)
    });
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * GET /admin_api/channelHub/health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const healthStatus = channelHubService.getHealthStatus();
    
    // Determine overall status
    let status = 'healthy';
    if (!healthStatus.initialized) {
      status = 'unhealthy';
    } else if (healthStatus.outbox.pending > 100) {
      status = 'degraded';
    }
    
    const response = {
      status,
      initialized: healthStatus.initialized,
      uptime: healthStatus.uptime,
      adapters: {
        total: healthStatus.adapters,
        healthy: healthStatus.adapters, // TODO: implement per-adapter health
        unhealthy: 0
      },
      outbox: healthStatus.outbox,
      modules: healthStatus.modules,
      timestamp: new Date().toISOString()
    };
    
    const statusCode = status === 'healthy' ? 200 : (status === 'degraded' ? 200 : 503);
    return res.status(statusCode).json({
      success: status !== 'unhealthy',
      data: response,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return fail(res, error, 503);
  }
});

router.get('/health/detailed', async (req, res) => {
  try {
    const healthStatus = channelHubService.getHealthStatus();
    return ok(res, healthStatus);
  } catch (error) {
    return fail(res, error, 503);
  }
});

/**
 * GET /admin_api/channelHub/audit-logs
 * Get audit logs
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const { 
      adapterId, 
      eventType, 
      startTime, 
      endTime, 
      limit = 100, 
      offset = 0 
    } = req.query;
    
    const auditLogger = getServiceModule('auditLogger');
    
    const filters = {};
    if (adapterId) filters.adapterId = adapterId;
    if (eventType) filters.eventType = eventType;
    if (startTime) filters.startTime = new Date(startTime);
    if (endTime) filters.endTime = new Date(endTime);
    
    const logs = await auditLogger.query({
      ...filters,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
    const total = await auditLogger.count(filters);
    
    return ok(res, logs, null, 200, {
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total
      }
    });
  } catch (error) {
    return fail(res, error);
  }
});

// ============================================================================
// Identity Mapping Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/identities
 * List identity mappings
 */
router.get('/identities', async (req, res) => {
  try {
    const { adapterId, externalId } = req.query;
    const identityStore = getServiceModule('identityMappingStore');
    
    const filters = {};
    if (adapterId) filters.adapterId = adapterId;
    if (externalId) filters.externalId = externalId;
    
    const identities = await identityStore.list(filters);
    
    return ok(res, identities);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/identities', async (req, res) => {
  try {
    const identityStore = getServiceModule('identityMappingStore');
    const mapping = await identityStore.linkIdentity(req.body || {});
    return ok(res, mapping, 'Identity mapping created successfully', 201);
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.put('/identities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const identityStore = getServiceModule('identityMappingStore');
    const mapping = await identityStore.linkIdentity({
      ...(req.body || {}),
      id
    });
    return ok(res, mapping, 'Identity mapping updated successfully');
  } catch (error) {
    return fail(res, error, 400);
  }
});

/**
 * DELETE /admin_api/channelHub/identities/:id
 * Delete an identity mapping
 */
router.delete('/identities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const identityStore = getServiceModule('identityMappingStore');
    
    await identityStore.delete(id);
    return ok(res, null, 'Identity mapping deleted successfully');
  } catch (error) {
    return fail(res, error);
  }
});

// ============================================================================
// Agent Routing Policy Routes
// ============================================================================

/**
 * GET /admin_api/channelHub/routing
 * List agent routing policies
 */
router.get('/routing', async (req, res) => {
  try {
    const routingPolicy = getServiceModule('agentRoutingPolicy');
    const policies = await routingPolicy.listPolicies();
    return ok(res, policies);
  } catch (error) {
    return fail(res, error);
  }
});

/**
 * POST /admin_api/channelHub/routing
 * Create or update routing policy
 */
router.post('/routing', async (req, res) => {
  try {
    const policyConfig = req.body;
    const routingPolicy = getServiceModule('agentRoutingPolicy');
    
    await routingPolicy.setPolicy(policyConfig);
    return ok(res, null, 'Routing policy updated successfully');
  } catch (error) {
    return fail(res, error, 400);
  }
});

router.get('/capabilities', async (req, res) => {
  try {
    const capabilityRegistry = getServiceModule('capabilityRegistry');
    const adapterRegistry = getServiceModule('adapterRegistry');
    const adapters = await adapterRegistry.listAdapters();

    const capabilities = await Promise.all(
      adapters.map(async (adapter) => ({
        adapterId: adapter.adapterId,
        channel: adapter.channel,
        profile: await capabilityRegistry.getProfile(adapter.adapterId)
      }))
    );

    return ok(res, capabilities);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/capabilities/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const capabilityRegistry = getServiceModule('capabilityRegistry');
    const adapterRegistry = getServiceModule('adapterRegistry');
    const adapters = await adapterRegistry.listAdapters();
    const matches = adapters.filter((adapter) => adapter.channel === channel);

    let profile = capabilityRegistry.getDefaultProfile(channel);
    if (matches.length > 0) {
      profile = await capabilityRegistry.getProfile(matches[0].adapterId);
    }

    return ok(res, {
      channel,
      profile,
      adapters: matches.map((adapter) => adapter.adapterId)
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.put('/capabilities/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const capabilityRegistry = getServiceModule('capabilityRegistry');
    const adapterRegistry = getServiceModule('adapterRegistry');
    const patch = req.body || {};
    const adapters = await adapterRegistry.listAdapters();
    const matches = adapters.filter((adapter) => adapter.channel === channel);

    let updated = 0;
    for (const adapter of matches) {
      const currentProfile = await capabilityRegistry.getProfile(adapter.adapterId);
      await adapterRegistry.updateAdapter(adapter.adapterId, {
        capabilityProfile: {
          ...currentProfile,
          ...patch
        }
      });
      updated += 1;
    }

    return ok(res, {
      channel,
      updated,
      profile: {
        ...capabilityRegistry.getDefaultProfile(channel),
        ...patch
      }
    }, 'Capability profile updated successfully');
  } catch (error) {
    return fail(res, error, 400);
  }
});

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  router,
  initialize
};
