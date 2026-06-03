'use strict';

/**
 * Native Doubao Secretless Runtime Delegate
 *
 * This module intentionally does not read process.env or provider secrets.
 * The caller must inject a ready pluginManager and explicitly enable the
 * delegate before any DoubaoGen tool call can be forwarded.
 */

const DOUBAO_TOOL_NAME = 'DoubaoGen';
const DEFAULT_REQUEST_IP = '127.0.0.1';
const DEFAULT_REQUEST_SOURCE = 'agent-image-lab-secretless-runtime';
const SECRETLESS_SERUM_ALLOWED_SIZE = '1920x1920';
const SECRETLESS_SERUM_SIZE_OVERRIDE_KEYS = [
  'resolution',
  'Resolution',
  'size',
  'Size',
  'image_size',
  'imageSize',
];

const ALLOWED_COMMANDS = new Set([
  'generate',
  'edit',
  'compose',
  'group',
]);

function failClosed(blocker, details = {}) {
  return {
    ok: false,
    status: 'blocked',
    blocker,
    provider_contact_performed: false,
    plugin_call_performed: false,
    api_call_performed: false,
    image_generation_performed: false,
    ...details,
  };
}

function normalizeNonEmptyString(value, fallback = null) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function createNativeDoubaoSecretlessRuntimeDelegate(options = {}) {
  const pluginManager = options.pluginManager || null;
  const enabled = options.enabled === true;
  const defaultRequestIp = normalizeNonEmptyString(options.requestIp, DEFAULT_REQUEST_IP);
  const bridgeId = normalizeNonEmptyString(
    options.bridgeId,
    'native_doubao_secretless_runtime_delegate'
  );

  return async function nativeDoubaoSecretlessRuntimeDelegate(request = {}) {
    if (!enabled) {
      return failClosed('native_doubao_secretless_runtime_delegate_not_enabled');
    }

    if (!pluginManager || typeof pluginManager.processToolCall !== 'function') {
      return failClosed('native_doubao_secretless_runtime_delegate_plugin_manager_not_callable');
    }

    const toolName = normalizeNonEmptyString(request.toolName, DOUBAO_TOOL_NAME);
    if (toolName !== DOUBAO_TOOL_NAME) {
      return failClosed('native_doubao_secretless_runtime_delegate_tool_not_allowed', {
        toolName,
      });
    }

    const toolArgs = request.toolArgs && typeof request.toolArgs === 'object'
      ? { ...request.toolArgs }
      : {};
    const command = normalizeNonEmptyString(toolArgs.command, null);

    if (!command || !ALLOWED_COMMANDS.has(command)) {
      return failClosed('native_doubao_secretless_runtime_delegate_command_not_allowed', {
        command,
      });
    }

    for (const key of SECRETLESS_SERUM_SIZE_OVERRIDE_KEYS) {
      delete toolArgs[key];
    }
    toolArgs.size = SECRETLESS_SERUM_ALLOWED_SIZE;

    const requestIp = normalizeNonEmptyString(request.requestIp, defaultRequestIp);
    const inputExecutionContext = request.executionContext && typeof request.executionContext === 'object'
      ? request.executionContext
      : {};
    const executionContext = {
      ...inputExecutionContext,
      requestSource: DEFAULT_REQUEST_SOURCE,
      bridgeId,
      providerBindingRefRedacted: true,
    };

    const result = await pluginManager.processToolCall(
      DOUBAO_TOOL_NAME,
      toolArgs,
      requestIp,
      executionContext
    );

    return {
      ok: true,
      status: 'completed',
      result,
      provider_contact_performed: true,
      plugin_call_performed: true,
      api_call_performed: true,
      image_generation_performed: true,
    };
  };
}

module.exports = {
  createNativeDoubaoSecretlessRuntimeDelegate,
  DOUBAO_TOOL_NAME,
  ALLOWED_COMMANDS,
  SECRETLESS_SERUM_ALLOWED_SIZE,
};
