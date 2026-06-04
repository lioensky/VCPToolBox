'use strict';

const SERUM_BOTTLE_SECRETLESS_DELEGATE_ID = 'serum_bottle_secretless_doubao_v1';
const SERUM_BOTTLE_SECRETLESS_PROVIDER_ID = 'doubao';
const SERUM_BOTTLE_SECRETLESS_PLUGIN_ID = 'DoubaoGen';
const SERUM_BOTTLE_SECRETLESS_API_ID = 'generate_image';
const SERUM_BOTTLE_SECRETLESS_INTERNAL_COMMAND = 'generate';
const SERUM_BOTTLE_SECRETLESS_ALLOWED_COMMANDS = Object.freeze([
  'generate',
  'edit',
  'compose',
  'group',
]);

function normalizeString(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

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

class NativeImageDelegateRegistry {
  constructor() {
    this.delegates = new Map();
  }

  register(delegate = {}) {
    const delegateId = normalizeString(delegate.delegateId);
    if (!delegateId) {
      throw new Error('native_image_delegate_id_required');
    }

    const handler = delegate.handler;
    if (typeof handler !== 'function') {
      throw new Error('native_image_delegate_handler_required');
    }

    this.delegates.set(delegateId, {
      delegateId,
      providerId: normalizeString(delegate.providerId),
      pluginId: normalizeString(delegate.pluginId),
      apiId: normalizeString(delegate.apiId),
      internalCommand: normalizeString(delegate.internalCommand),
      allowedCommands: new Set(
        Array.isArray(delegate.allowedCommands) && delegate.allowedCommands.length > 0
          ? delegate.allowedCommands.map((item) => normalizeString(item)).filter(Boolean)
          : [normalizeString(delegate.internalCommand)].filter(Boolean)
      ),
      enabled: delegate.enabled === true,
      handler,
    });

    return this;
  }

  get(delegateId) {
    return this.delegates.get(delegateId) || null;
  }

  hasCallable(delegateId) {
    const delegate = this.get(delegateId);
    return Boolean(delegate && delegate.enabled === true && typeof delegate.handler === 'function');
  }

  async invokeBoundDelegate(binding = {}, request = {}) {
    const delegateId = normalizeString(binding.delegateId);
    const delegate = this.get(delegateId);
    if (!delegate) {
      return failClosed('native_image_delegate_registry_delegate_missing', { delegateId });
    }

    if (delegate.enabled !== true) {
      return failClosed('native_image_delegate_registry_delegate_disabled', { delegateId });
    }

    const expected = {
      providerId: normalizeString(binding.providerId),
      pluginId: normalizeString(binding.pluginId),
      apiId: normalizeString(binding.apiId),
      internalCommand: normalizeString(binding.internalCommand),
    };

    const mismatches = Object.entries(expected)
      .filter(([key, value]) => value && delegate[key] !== value)
      .map(([key]) => key);
    if (mismatches.length > 0) {
      return failClosed('native_image_delegate_registry_binding_mismatch', {
        delegateId,
        mismatches,
      });
    }

    const toolArgs = request.toolArgs && typeof request.toolArgs === 'object'
      ? { ...request.toolArgs }
      : {};
    const requiredCommand = normalizeString(binding.internalCommand);
    if (requiredCommand && toolArgs.command !== requiredCommand) {
      return failClosed('native_image_delegate_registry_command_not_allowed', {
        delegateId,
        command: toolArgs.command || null,
        requiredCommand,
      });
    }

    if (!requiredCommand && !delegate.allowedCommands.has(toolArgs.command)) {
      return failClosed('native_image_delegate_registry_command_not_allowed', {
        delegateId,
        command: toolArgs.command || null,
        allowedCommands: Array.from(delegate.allowedCommands),
      });
    }

    const result = await delegate.handler(request);
    if (!result || result.ok !== true) {
      return result || failClosed('native_image_delegate_registry_delegate_failed_closed', { delegateId });
    }

    return {
      ...result,
      delegateEvidence: {
        delegateId: delegate.delegateId,
        providerId: delegate.providerId,
        pluginId: delegate.pluginId,
        apiId: delegate.apiId,
        internalCommand: delegate.internalCommand,
      },
    };
  }
}

function createNativeImageDelegateRegistry() {
  return new NativeImageDelegateRegistry();
}

function registerSerumBottleSecretlessDoubaoDelegate(registry, handler, options = {}) {
  if (!registry || typeof registry.register !== 'function') {
    throw new Error('native_image_delegate_registry_required');
  }

  return registry.register({
    delegateId: SERUM_BOTTLE_SECRETLESS_DELEGATE_ID,
    providerId: SERUM_BOTTLE_SECRETLESS_PROVIDER_ID,
    pluginId: SERUM_BOTTLE_SECRETLESS_PLUGIN_ID,
    apiId: SERUM_BOTTLE_SECRETLESS_API_ID,
    internalCommand: SERUM_BOTTLE_SECRETLESS_INTERNAL_COMMAND,
    allowedCommands: options.allowedCommands || SERUM_BOTTLE_SECRETLESS_ALLOWED_COMMANDS,
    enabled: options.enabled === true,
    handler,
  });
}

module.exports = {
  NativeImageDelegateRegistry,
  createNativeImageDelegateRegistry,
  registerSerumBottleSecretlessDoubaoDelegate,
  SERUM_BOTTLE_SECRETLESS_DELEGATE_ID,
  SERUM_BOTTLE_SECRETLESS_PROVIDER_ID,
  SERUM_BOTTLE_SECRETLESS_PLUGIN_ID,
  SERUM_BOTTLE_SECRETLESS_API_ID,
  SERUM_BOTTLE_SECRETLESS_INTERNAL_COMMAND,
  SERUM_BOTTLE_SECRETLESS_ALLOWED_COMMANDS,
};
