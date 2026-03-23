/**
 * routes/internal/channelHub.js
 * 
 * ChannelHub Internal Routes - 平台 Webhook 回调处理
 * 
 * Routes:
 * - GET  /health                    - 健康检查
 * - POST /webhook/:channel          - 统一 Webhook 入口
 * - POST /dingtalk/callback         - 钉钉回调
 * - POST /wecom/callback            - 企业微信回调
 * - POST /feishu/callback           - 飞书回调
 * - POST /qq/callback               - QQ 回调
 * - POST /wechat/callback           - 微信回调
 * - POST /b1/ingest                 - B1 兼容层入口
 * 
 * 挂载方式（在 server.js 中）:
 *   const channelHubRoutes = require('./routes/internal/channelHub');
 *   channelHubRoutes.initialize({ channelHubService });
 *   app.use('/internal/channelHub', channelHubRoutes.router);
 */

const express = require('express');
const router = express.Router();
const { toHttpResponse } = require('../../modules/channelHub/errors');

// 服务实例引用
let channelHubService = null;

/**
 * 初始化路由依赖
 * @param {Object} services
 * @param {import('../../modules/channelHub/ChannelHubService').ChannelHubService} services.channelHubService
 */
function initialize(services) {
  channelHubService = services.channelHubService;
}

// ============================================================
// Middleware: 请求追踪
// ============================================================
function requestTracer(req, res, next) {
  const startTime = Date.now();
  const traceId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req._traceId = traceId;
  req._startTime = startTime;
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (duration > 5000) {
      console.warn(`[ChannelHub] Slow request: ${req.method} ${req.path} took ${duration}ms`);
    }
  });
  
  next();
}

// ============================================================
// Middleware: 服务可用性检查
// ============================================================
function serviceGuard(req, res, next) {
  if (!channelHubService || !channelHubService.initialized) {
    return res.status(503).json({
      ok: false,
      error: {
        code: 'SERVICE_NOT_INITIALIZED',
        message: 'ChannelHubService is not available'
      }
    });
  }
  next();
}

// ============================================================
// Middleware: 适配器鉴权
// ============================================================
async function adapterAuthMiddleware(req, res, next) {
  if (!channelHubService?.adapterAuthManager) {
    return next();
  }
  
  try {
    const result = await channelHubService.adapterAuthManager.authenticate(
      req.headers,
      req.ip
    );
    
    if (!result.authenticated) {
      return res.status(401).json({
        ok: false,
        error: {
          code: 'AUTH_FAILED',
          message: result.error || 'Authentication failed'
        }
      });
    }
    
    req._adapterId = result.adapterId;
    next();
  } catch (error) {
    console.error('[ChannelHub] Auth middleware error:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 'AUTH_ERROR', message: error.message }
    });
  }
}

// ============================================================
// Middleware: 签名验证工厂
// ============================================================
function createSignatureMiddleware(channel) {
  return async function signatureMiddleware(req, res, next) {
    const validator = channelHubService?.signatureValidator;
    if (!validator) {
      return next();
    }
    
    try {
      const adapterId = req._adapterId || req.headers['x-channel-adapter-id'] || `${channel}-default`;
      const adapter = await channelHubService.adapterRegistry.getAdapter(adapterId);
      
      if (!adapter) {
        return next();
      }
      
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const result = await validator.validate(adapter, req.headers, rawBody);
      
      if (!result.valid) {
        return res.status(401).json({
          ok: false,
          error: {
            code: 'SIGNATURE_INVALID',
            message: result.reason || 'Invalid signature',
            channel
          }
        });
      }
      
      next();
    } catch (error) {
      console.error(`[ChannelHub] Signature validation error for ${channel}:`, error);
      return res.status(500).json({
        ok: false,
        error: { code: 'SIGNATURE_ERROR', message: error.message }
      });
    }
  };
}

// ============================================================
// Middleware: 事件去重
// ============================================================
async function deduplicationMiddleware(req, res, next) {
  const deduplicator = channelHubService?.eventDeduplicator;
  if (!deduplicator) {
    return next();
  }
  
  try {
    const eventId = req.body?.eventId || req.headers['x-event-id'];
    if (eventId) {
      const miniEnvelope = {
        adapterId: req._adapterId || req.headers['x-channel-adapter-id'] || 'unknown',
        eventId,
        channel: req.params?.channel || req.body?.channel || 'unknown',
        client: { messageId: req.body?.client?.messageId }
      };
      
      const result = await deduplicator.checkAndMark(miniEnvelope);
      if (result.isDuplicate) {
        return res.status(200).json({
          ok: true,
          status: 'duplicate',
          message: 'Duplicate event ignored',
          eventId
        });
      }
    }
    next();
  } catch (error) {
    console.error('[ChannelHub] Deduplication error:', error);
    next();
  }
}

// ============================================================
// 统一 Webhook 处理器
// ============================================================
async function handleWebhook(req, res) {
  const channel = req.params?.channel || req.body?.channel || 'unknown';
  const adapterId = req._adapterId || req.headers['x-channel-adapter-id'] || `${channel}-default`;
  
  try {
    // URL 验证请求（各平台通用）
    if (req.body?.type === 'url_verification') {
      return res.status(200).json({
        challenge: req.body.challenge || req.body.token
      });
    }
    
    // 调用 ChannelHubService 主流程
    const result = await channelHubService.handleInboundEvent(
      adapterId,
      req.body,
      {
        traceId: req._traceId,
        headers: req.headers,
        sourceIp: req.ip
      }
    );
    
    // 如果是 B1 格式请求且有 reply，返回 B1 格式回复
    if (result.reply && channelHubService.b1CompatTranslator) {
      const b1Reply = channelHubService.b1CompatTranslator.translateReply(result.reply);
      return res.status(200).json({
        ok: true,
        ...result,
        ...b1Reply
      });
    }
    
    res.status(200).json({ ok: true, ...result });
    
  } catch (error) {
    console.error(`[ChannelHub] Webhook processing error for ${channel}:`, error);
    const httpResponse = toHttpResponse(error);
    res.status(httpResponse.status).json(httpResponse.body);
  }
}

// ============================================================
// B2 Events 入口
// ============================================================
async function handleEvents(req, res) {
  const adapterId =
    req._adapterId ||
    req.headers['x-channel-adapter-id'] ||
    req.body?.adapterId ||
    'unknown-adapter';

  try {
    const result = await channelHubService.handleInboundEvent(
      adapterId,
      req.body,
      {
        traceId: req._traceId,
        headers: req.headers,
        sourceIp: req.ip
      }
    );

    return res.status(200).json({
      ok: true,
      requestId: req.body?.requestId || result.eventId,
      ...result
    });
  } catch (error) {
    console.error('[ChannelHub] B2 events error:', error);
    const httpResponse = toHttpResponse(error);
    return res.status(httpResponse.status).json(httpResponse.body);
  }
}

// ============================================================
// B1 兼容层处理器
// ============================================================
async function handleB1Ingest(req, res) {
  const adapterId = req._adapterId || req.headers['x-channel-adapter-id'] || 'b1-compat';
  
  try {
    const result = await channelHubService.handleInboundEvent(
      adapterId,
      req.body,
      {
        traceId: req._traceId,
        headers: req.headers,
        sourceIp: req.ip
      }
    );
    
    if (result.reply && channelHubService.b1CompatTranslator) {
      const b1Reply = channelHubService.b1CompatTranslator.translateReply(result.reply);
      return res.status(200).json({
        ok: true,
        eventId: result.eventId,
        ...b1Reply
      });
    }
    
    res.status(200).json({ ok: true, ...result });
    
  } catch (error) {
    console.error('[ChannelHub] B1 ingest error:', error);
    const httpResponse = toHttpResponse(error);
    res.status(httpResponse.status).json(httpResponse.body);
  }
}

// ============================================================
// 路由定义
// ============================================================

// 健康检查
router.get('/health', (req, res) => {
  if (!channelHubService) {
    return res.status(503).json({
      status: 'unavailable',
      service: 'channelHub',
      timestamp: new Date().toISOString()
    });
  }
  
  res.status(200).json({
    status: 'healthy',
    service: 'channelHub',
    timestamp: new Date().toISOString(),
    ...channelHubService.getHealthStatus()
  });
});

// 统一 Webhook 入口
router.post('/webhook/:channel',
  requestTracer, serviceGuard, adapterAuthMiddleware, deduplicationMiddleware, handleWebhook
);

// B2 标准事件入口
router.post('/events',
  requestTracer, serviceGuard, adapterAuthMiddleware, deduplicationMiddleware, handleEvents
);

// 平台专用端点
router.post('/dingtalk/callback',
  requestTracer, serviceGuard, adapterAuthMiddleware,
  createSignatureMiddleware('dingtalk'), deduplicationMiddleware,
  (req, res, next) => { req.params = { ...req.params, channel: 'dingtalk' }; next(); },
  handleWebhook
);

router.post('/wecom/callback',
  requestTracer, serviceGuard, adapterAuthMiddleware,
  createSignatureMiddleware('wecom'), deduplicationMiddleware,
  (req, res, next) => { req.params = { ...req.params, channel: 'wecom' }; next(); },
  handleWebhook
);

router.post('/feishu/callback',
  requestTracer, serviceGuard, adapterAuthMiddleware,
  createSignatureMiddleware('feishu'), deduplicationMiddleware,
  (req, res, next) => { req.params = { ...req.params, channel: 'feishu' }; next(); },
  handleWebhook
);

router.post('/qq/callback',
  requestTracer, serviceGuard, adapterAuthMiddleware,
  createSignatureMiddleware('qq'), deduplicationMiddleware,
  (req, res, next) => { req.params = { ...req.params, channel: 'qq' }; next(); },
  handleWebhook
);

router.post('/wechat/callback',
  requestTracer, serviceGuard, adapterAuthMiddleware,
  createSignatureMiddleware('wechat'), deduplicationMiddleware,
  (req, res, next) => { req.params = { ...req.params, channel: 'wechat' }; next(); },
  handleWebhook
);

// B1 兼容层
router.post('/b1/ingest',
  requestTracer, serviceGuard, adapterAuthMiddleware, deduplicationMiddleware, handleB1Ingest
);

// 历史兼容别名
router.post('/channel-ingest',
  requestTracer, serviceGuard, adapterAuthMiddleware, deduplicationMiddleware, handleB1Ingest
);

// ============================================================
// 导出
// ============================================================
module.exports = { router, initialize };
