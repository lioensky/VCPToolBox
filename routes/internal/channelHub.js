/**
 * routes/internal/channelHub.js
 * 
 * ChannelHub Internal Routes - 平台 Webhook 回调处理
 * 
 * Responsibility:
 * - 接收各平台的 Webhook 回调
 * - 处理签名验证、事件解析、转发到 ChannelHubService
 * - 支持 B1 兼容层（对接现有 /internal/channel-ingest）
 * 
 * Routes:
 * - POST /internal/channelHub/webhook/:channel - 统一 Webhook 入口
 * - POST /internal/channelHub/dingtalk/callback - 钉钉回调
 * - POST /internal/channelHub/wecom/callback - 企业微信回调
 * - POST /internal/channelHub/feishu/callback - 飞书回调
 * - POST /internal/channelHub/qq/callback - QQ 回调
 * - POST /internal/channelHub/wechat/callback - 微信回调
 * - POST /internal/channelHub/b1/ingest - B1 兼容层入口
 * 
 * Exports:
 * - Router (Express Router instance)
 */

const express = require('express');
const router = express.Router();

// Module imports (will be properly wired during implementation)
// const ChannelHubService = require('../../modules/channelHub/ChannelHubService');
// const SignatureValidator = require('../../modules/channelHub/SignatureValidator');
// const B1CompatTranslator = require('../../modules/channelHub/B1CompatTranslator');
// const EventDeduplicator = require('../../modules/channelHub/EventDeduplicator');
// const EventSchemaValidator = require('../../modules/channelHub/EventSchemaValidator');
// const AuditLogger = require('../../modules/channelHub/AuditLogger');

// Placeholder for service instances
let channelHubService = null;
let signatureValidator = null;
let b1CompatTranslator = null;
let eventDeduplicator = null;
let eventSchemaValidator = null;
let auditLogger = null;

/**
 * Initialize route dependencies
 * @param {Object} services - Service instances
 * @param {ChannelHubService} services.channelHubService - Main service
 * @param {SignatureValidator} services.signatureValidator - Signature validator
 * @param {B1CompatTranslator} services.b1CompatTranslator - B1 translator
 * @param {EventDeduplicator} services.eventDeduplicator - Deduplicator
 * @param {EventSchemaValidator} services.eventSchemaValidator - Schema validator
 * @param {AuditLogger} services.auditLogger - Audit logger
 */
function initialize(services) {
  channelHubService = services.channelHubService;
  signatureValidator = services.signatureValidator;
  b1CompatTranslator = services.b1CompatTranslator;
  eventDeduplicator = services.eventDeduplicator;
  eventSchemaValidator = services.eventSchemaValidator;
  auditLogger = services.auditLogger;
}

// ============================================================
// Middleware: Request Logger
// ============================================================
function requestLogger(req, res, next) {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  req.startTime = startTime;
  
  // Log incoming request
  if (auditLogger) {
    auditLogger.logInbound({
      requestId,
      method: req.method,
      path: req.path,
      channel: req.params.channel,
      headers: req.headers,
      bodySize: JSON.stringify(req.body).length
    });
  }
  
  // Response finish hook
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (auditLogger) {
      auditLogger.logResponse({
        requestId,
        statusCode: res.statusCode,
        duration
      });
    }
  });
  
  next();
}

// ============================================================
// Middleware: Signature Validator Factory
// ============================================================
function createSignatureMiddleware(channel) {
  return async function signatureMiddleware(req, res, next) {
    if (!signatureValidator) {
      console.warn('[ChannelHub] SignatureValidator not initialized, skipping validation');
      return next();
    }
    
    try {
      const isValid = await signatureValidator.validate(channel, {
        headers: req.headers,
        body: req.body,
        rawBody: req.rawBody || JSON.stringify(req.body)
      });
      
      if (!isValid) {
        return res.status(401).json({
          error: 'Invalid signature',
          channel
        });
      }
      
      next();
    } catch (error) {
      console.error(`[ChannelHub] Signature validation error for ${channel}:`, error);
      return res.status(500).json({
        error: 'Signature validation failed',
        message: error.message
      });
    }
  };
}

// ============================================================
// Middleware: Event Deduplication
// ============================================================
async function deduplicationMiddleware(req, res, next) {
  if (!eventDeduplicator) {
    return next();
  }
  
  try {
    const eventId = req.body.eventId || req.headers['x-event-id'];
    if (eventId) {
      const isDuplicate = await eventDeduplicator.check(eventId);
      if (isDuplicate) {
        return res.status(200).json({
          success: true,
          message: 'Duplicate event ignored',
          eventId
        });
      }
    }
    next();
  } catch (error) {
    console.error('[ChannelHub] Deduplication error:', error);
    next(); // Continue on dedup error
  }
}

// ============================================================
// Main Webhook Handler
// ============================================================
async function handleWebhook(req, res) {
  const { channel } = req.params;
  
  if (!channelHubService) {
    return res.status(503).json({
      error: 'Service not initialized',
      message: 'ChannelHubService is not available'
    });
  }
  
  try {
    // Parse and normalize the event
    const adapter = channelHubService.getAdapter(channel);
    if (!adapter) {
      return res.status(400).json({
        error: 'Unknown channel',
        channel
      });
    }
    
    // Handle URL verification (common for messaging platforms)
    if (req.body && (req.body.type === 'url_verification' || req.body.msg_signature)) {
      return handleUrlVerification(req, res, channel, adapter);
    }
    
    // Build event envelope
    const envelope = await adapter.parseWebhook({
      headers: req.headers,
      body: req.body,
      rawBody: req.rawBody
    });
    
    // Validate schema
    if (eventSchemaValidator) {
      const validation = eventSchemaValidator.validate(envelope);
      if (!validation.valid) {
        console.error('[ChannelHub] Schema validation failed:', validation.errors);
        return res.status(400).json({
          error: 'Invalid event schema',
          details: validation.errors
        });
      }
    }
    
    // Process through service
    const result = await channelHubService.processEvent(envelope);
    
    // Return success
    res.status(200).json({
      success: true,
      eventId: envelope.eventId,
      result
    });
    
  } catch (error) {
    console.error(`[ChannelHub] Webhook processing error for ${channel}:`, error);
    res.status(500).json({
      error: 'Processing failed',
      message: error.message
    });
  }
}

// ============================================================
// URL Verification Handler
// ============================================================
async function handleUrlVerification(req, res, channel, adapter) {
  try {
    const challenge = await adapter.handleUrlVerification(req.body);
    res.status(200).send(challenge);
  } catch (error) {
    console.error(`[ChannelHub] URL verification failed for ${channel}:`, error);
    res.status(400).json({
      error: 'URL verification failed',
      message: error.message
    });
  }
}

// ============================================================
// B1 Compatibility Layer
// ============================================================
async function handleB1Ingest(req, res) {
  if (!b1CompatTranslator) {
    return res.status(503).json({
      error: 'B1 compatibility layer not available'
    });
  }
  
  try {
    // Translate B1 format to B2 envelope
    const envelope = await b1CompatTranslator.translate(req.body);
    
    // Process through service
    const result = await channelHubService.processEvent(envelope);
    
    res.status(200).json({
      success: true,
      eventId: envelope.eventId,
      result
    });
    
  } catch (error) {
    console.error('[ChannelHub] B1 ingest error:', error);
    res.status(500).json({
      error: 'B1 ingest failed',
      message: error.message
    });
  }
}

// ============================================================
// Health Check
// ============================================================
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'channelHub',
    timestamp: new Date().toISOString(),
    components: {
      channelHubService: channelHubService ? 'initialized' : 'not initialized',
      signatureValidator: signatureValidator ? 'initialized' : 'not initialized',
      eventDeduplicator: eventDeduplicator ? 'initialized' : 'not initialized',
      auditLogger: auditLogger ? 'initialized' : 'not initialized'
    }
  });
});

// ============================================================
// Route Definitions
// ============================================================

// Generic webhook endpoint
router.post('/webhook/:channel',
  requestLogger,
  deduplicationMiddleware,
  handleWebhook
);

// Channel-specific endpoints with signature validation
router.post('/dingtalk/callback',
  requestLogger,
  createSignatureMiddleware('dingtalk'),
  deduplicationMiddleware,
  handleWebhook
);

router.post('/wecom/callback',
  requestLogger,
  createSignatureMiddleware('wecom'),
  deduplicationMiddleware,
  handleWebhook
);

router.post('/feishu/callback',
  requestLogger,
  createSignatureMiddleware('feishu'),
  deduplicationMiddleware,
  handleWebhook
);

router.post('/qq/callback',
  requestLogger,
  createSignatureMiddleware('qq'),
  deduplicationMiddleware,
  handleWebhook
);

router.post('/wechat/callback',
  requestLogger,
  createSignatureMiddleware('wechat'),
  deduplicationMiddleware,
  handleWebhook
);

// B1 compatibility layer
router.post('/b1/ingest',
  requestLogger,
  deduplicationMiddleware,
  handleB1Ingest
);

// ============================================================
// Exports
// ============================================================
module.exports = {
  router,
  initialize
};