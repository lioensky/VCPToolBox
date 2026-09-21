const HOST_INTEGRATION_ID_SOURCE = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const HOST_INTEGRATION_ID_PATTERN = new RegExp(`^${HOST_INTEGRATION_ID_SOURCE}$`);
const ASYNC_PLACEHOLDER_PATTERN = new RegExp(
  `\\{\\{VCP_ASYNC_RESULT::(${HOST_INTEGRATION_ID_SOURCE})::(${HOST_INTEGRATION_ID_SOURCE})\\}\\}`,
  'g'
);

function normalizeIntegrationId(value) {
  if (typeof value !== 'string' || !HOST_INTEGRATION_ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function normalizeRequestContext(requestContext = {}) {
  const source = requestContext && typeof requestContext === 'object' ? requestContext : {};
  return {
    parentRequestId: normalizeIntegrationId(source.parentRequestId ?? source.requestId),
    parentMessageId: normalizeIntegrationId(source.parentMessageId ?? source.messageId)
  };
}

function deriveRequestContextFromOriginalBody(originalBody = {}) {
  const source = originalBody && typeof originalBody === 'object' ? originalBody : {};
  return normalizeRequestContext({
    requestId: source.requestId,
    messageId: source.messageId
  });
}

function bindToolExecutorToOriginalBody(toolExecutor, originalBody) {
  if (
    !toolExecutor ||
    typeof toolExecutor.execute !== 'function' ||
    typeof toolExecutor.executeAll !== 'function'
  ) {
    throw new TypeError('toolExecutor must provide execute and executeAll');
  }

  const requestContext = Object.freeze(
    deriveRequestContextFromOriginalBody(originalBody)
  );
  return Object.freeze({
    requestContext,
    execute(toolCall, clientIp, contextMessages) {
      return toolExecutor.execute(toolCall, clientIp, contextMessages, requestContext);
    },
    executeAll(toolCalls, clientIp, contextMessages) {
      return toolExecutor.executeAll(toolCalls, clientIp, contextMessages, requestContext);
    }
  });
}

function extractAsyncTaskId(result, pluginName) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const canonicalTaskId = normalizeIntegrationId(result.taskId);
  if (canonicalTaskId) {
    return canonicalTaskId;
  }

  const pluginOutput = result.original_plugin_output;
  if (typeof pluginOutput !== 'string') {
    return null;
  }

  const expectedPluginName = normalizeIntegrationId(pluginName);
  if (!expectedPluginName) {
    return null;
  }

  for (const match of pluginOutput.matchAll(ASYNC_PLACEHOLDER_PATTERN)) {
    if (match[1] === expectedPluginName) {
      return normalizeIntegrationId(match[2]);
    }
  }
  return null;
}

function formatListenerError(eventName, error) {
  const errorType = error?.name || typeof error;
  const errorMessage = error?.message || String(error);
  return `[HostIntegration] listener failed event=${eventName} errorType=${errorType} message=${errorMessage}`;
}

function logListenerError(logger, eventName, error) {
  try {
    logger?.error?.(formatListenerError(eventName, error));
  } catch (_) {
    // Logging must never affect event delivery.
  }
}

function dispatchIntegrationEvent(emitter, eventName, event, options = {}) {
  const logger = options.logger || console;
  const listeners = typeof emitter?.rawListeners === 'function'
    ? emitter.rawListeners(eventName)
    : [];
  let delivered = 0;
  let failed = 0;

  for (const listener of listeners) {
    try {
      const listenerResult = listener.call(emitter, event);
      if (listenerResult && typeof listenerResult.then === 'function') {
        Promise.resolve(listenerResult).catch(error => {
          logListenerError(logger, eventName, error);
        });
      }
      delivered += 1;
    } catch (error) {
      failed += 1;
      logListenerError(logger, eventName, error);
    }
  }

  return {
    eventName,
    total: listeners.length,
    delivered,
    failed,
    ok: failed === 0
  };
}

module.exports = {
  bindToolExecutorToOriginalBody,
  deriveRequestContextFromOriginalBody,
  dispatchIntegrationEvent,
  extractAsyncTaskId,
  normalizeIntegrationId,
  normalizeRequestContext
};
