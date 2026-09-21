const path = require('path');

const { normalizeIntegrationId } = require('../hostIntegration');

function logSideEffectError(logger, sideEffect, error) {
  const errorType = error?.name || typeof error;
  const errorMessage = error?.message || String(error);
  try {
    logger?.error?.(`[PluginCallback] ${sideEffect} failed errorType=${errorType} message=${errorMessage}`);
  } catch (_) {
    // Logging is never part of callback success semantics.
  }
}

function sendJson(res, statusCode, body) {
  return res.status(statusCode).json(body);
}

function createPluginCallbackHandler({
  asyncResultsDir,
  fsPromises,
  pluginManager,
  webSocketServer,
  logger = console,
  debugMode = false
}) {
  if (!asyncResultsDir || !fsPromises || !pluginManager) {
    throw new TypeError('plugin callback handler dependencies are incomplete');
  }

  return async function pluginCallbackHandler(req, res) {
    const pluginName = normalizeIntegrationId(req?.params?.pluginName);
    const taskId = normalizeIntegrationId(req?.params?.taskId);
    if (!pluginName || !taskId) {
      return sendJson(res, 400, {
        status: 'error',
        message: 'Invalid plugin callback route identifiers.'
      });
    }

    const callbackData = req.body;
    const resultFilePath = path.join(asyncResultsDir, `${pluginName}-${taskId}.json`);
    try {
      await fsPromises.mkdir(asyncResultsDir, { recursive: true });
      await fsPromises.writeFile(
        resultFilePath,
        JSON.stringify(callbackData, null, 2),
        'utf-8'
      );
    } catch (error) {
      logSideEffectError(logger, 'persistence', error);
      return sendJson(res, 500, {
        status: 'error',
        message: 'Failed to persist plugin callback.'
      });
    }

    let pluginManifest = null;
    try {
      pluginManifest = pluginManager.getPlugin(pluginName) || null;
    } catch (error) {
      logSideEffectError(logger, 'manifest lookup', error);
    }

    if (pluginManifest?.webSocketPush?.enabled) {
      try {
        const targetClientType = pluginManifest.webSocketPush.targetClientType || null;
        const wsMessage = {
          type: pluginManifest.webSocketPush.messageType || 'plugin_callback_notification',
          data: callbackData
        };
        webSocketServer?.broadcast?.(wsMessage, targetClientType);
      } catch (error) {
        logSideEffectError(logger, 'legacy WebSocket notification', error);
      }
    }

    try {
      pluginManager.emitAsyncTaskCompleted(pluginName, taskId);
    } catch (error) {
      logSideEffectError(logger, 'Host Integration notification', error);
    }

    if (debugMode) {
      try {
        logger?.log?.(`[PluginCallback] persisted plugin=${pluginName} task=${taskId}`);
      } catch (_) {
        // Debug logging is optional.
      }
    }

    return sendJson(res, 200, {
      status: 'success',
      message: 'Callback received and processed'
    });
  };
}

module.exports = {
  createPluginCallbackHandler
};
