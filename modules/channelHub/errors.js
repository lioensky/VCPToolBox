/**
 * modules/channelHub/errors.js
 * 
 * 统一 ChannelHub 错误类型
 * 让路由和审计都能拿到结构化错误
 * 
 * @description 目标：路由层能根据错误类型返回明确状态码，审计日志能保存结构化错误对象
 */

/**
 * 基础 ChannelHub 错误类
 */
class ChannelHubError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ChannelHubError';
    this.code = options.code || 'CHANNEL_HUB_ERROR';
    this.httpStatus = options.httpStatus || 500;
    this.details = options.details || null;
    this.retryable = options.retryable || false;
    this.timestamp = Date.now();
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      httpStatus: this.httpStatus,
      details: this.details,
      retryable: this.retryable,
      timestamp: this.timestamp
    };
  }
}

/**
 * 适配器认证错误
 */
class AdapterAuthError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ADAPTER_AUTH_ERROR',
      httpStatus: 401,
      ...options
    });
    this.name = 'AdapterAuthError';
  }
}

/**
 * 签名验证失败
 */
class SignatureValidationError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'SIGNATURE_VALIDATION_ERROR',
      httpStatus: 401,
      ...options
    });
    this.name = 'SignatureValidationError';
  }
}

/**
 * 事件格式验证失败
 */
class EventValidationError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'EVENT_VALIDATION_ERROR',
      httpStatus: 400,
      ...options
    });
    this.name = 'EventValidationError';
  }
}

/**
 * 去重错误（重复事件）
 */
class DeduplicationError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'DEDUPLICATION_ERROR',
      httpStatus: 200, // 重复请求不视为错误，返回成功但不处理
      ...options
    });
    this.name = 'DeduplicationError';
  }
}

/**
 * 路由错误
 */
class RoutingError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ROUTING_ERROR',
      httpStatus: 500,
      ...options
    });
    this.name = 'RoutingError';
  }
}

/**
 * 运行时网关错误
 */
class RuntimeGatewayError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'RUNTIME_GATEWAY_ERROR',
      httpStatus: 502,
      retryable: true,
      ...options
    });
    this.name = 'RuntimeGatewayError';
  }
}

/**
 * 投递错误
 */
class DeliveryError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'DELIVERY_ERROR',
      httpStatus: 502,
      retryable: true,
      ...options
    });
    this.name = 'DeliveryError';
  }
}

/**
 * 媒体网关错误
 */
class MediaGatewayError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'MEDIA_GATEWAY_ERROR',
      httpStatus: 500,
      ...options
    });
    this.name = 'MediaGatewayError';
  }
}

/**
 * 适配器未找到
 */
class AdapterNotFoundError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ADAPTER_NOT_FOUND',
      httpStatus: 404,
      ...options
    });
    this.name = 'AdapterNotFoundError';
  }
}

/**
 * 会话绑定错误
 */
class SessionBindingError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'SESSION_BINDING_ERROR',
      httpStatus: 500,
      ...options
    });
    this.name = 'SessionBindingError';
  }
}

/**
 * 能力降级错误
 */
class CapabilityDowngradeError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'CAPABILITY_DOWNGRADE_ERROR',
      httpStatus: 500,
      ...options
    });
    this.name = 'CapabilityDowngradeError';
  }
}

/**
 * 状态存储错误
 */
class StateStoreError extends ChannelHubError {
  constructor(message, options = {}) {
    super(message, {
      code: 'STATE_STORE_ERROR',
      httpStatus: 500,
      ...options
    });
    this.name = 'StateStoreError';
  }
}

/**
 * 根据错误类型判断是否可重试
 * @param {Error} error - 错误对象
 * @returns {boolean}
 */
function isRetryable(error) {
  if (error instanceof ChannelHubError) {
    return error.retryable;
  }
  // 网络错误默认可重试
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }
  return false;
}

/**
 * 将错误转换为 HTTP 响应格式
 * @param {Error} error - 错误对象
 * @returns {{status: number, body: object}}
 */
function toHttpResponse(error) {
  if (error instanceof ChannelHubError) {
    return {
      status: error.httpStatus,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.retryable
        }
      }
    };
  }
  
  // 未知错误
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message || 'Unknown error',
        retryable: false
      }
    }
  };
}

module.exports = {
  ChannelHubError,
  AdapterAuthError,
  SignatureValidationError,
  EventValidationError,
  DeduplicationError,
  RoutingError,
  RuntimeGatewayError,
  DeliveryError,
  MediaGatewayError,
  MediaError: MediaGatewayError, // 别名，兼容 MediaGateway.js 的 import
  AdapterNotFoundError,
  SessionBindingError,
  CapabilityDowngradeError,
  StateStoreError,
  
  // 辅助函数
  isRetryable,
  toHttpResponse
};
