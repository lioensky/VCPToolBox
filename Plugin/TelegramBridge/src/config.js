'use strict';

const path = require('node:path');

const CONFIG_ERROR_MESSAGE = 'Invalid TelegramBridge configuration.';

const TELEGRAM_CONFIG_KEYS = Object.freeze([
  'TELEGRAM_MODE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_GROUPS_ENABLED',
  'TELEGRAM_DEFAULT_AGENT',
  'TELEGRAM_ALLOWED_AGENTS',
  'TELEGRAM_POLL_TIMEOUT_SEC',
  'TELEGRAM_UPDATE_LIMIT',
  'TELEGRAM_MAX_CONCURRENT_SCOPES',
  'TELEGRAM_MAX_QUEUED_TOTAL',
  'TELEGRAM_MAX_QUEUED_PER_SCOPE',
  'TELEGRAM_MAX_INBOUND_BYTES',
  'TELEGRAM_MAX_OUTBOUND_BYTES',
  'TELEGRAM_OUTBOUND_DNS',
  'TELEGRAM_HISTORY_MAX_MESSAGES',
  'TELEGRAM_HISTORY_MAX_BYTES',
  'TELEGRAM_STATE_DIR',
  'TELEGRAM_VCP_BASE_URL',
  'TELEGRAM_VCP_MODEL',
  'TELEGRAM_AGENT_MODELS',
  'TELEGRAM_VCP_TEMPERATURE',
  'TELEGRAM_VCP_MAX_TOKENS',
  'TELEGRAM_VCP_KEY',
  'TELEGRAM_STREAM_MODE',
  'TELEGRAM_PROACTIVE_ENABLED',
  'TELEGRAM_LOG_CONTENT',
]);

const KNOWN_KEYS = new Set(TELEGRAM_CONFIG_KEYS);
const DEFAULTS = Object.freeze({
  TELEGRAM_MODE: 'disabled',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_ALLOWED_USER_IDS: '',
  TELEGRAM_ALLOWED_CHAT_IDS: '',
  TELEGRAM_GROUPS_ENABLED: 'false',
  TELEGRAM_DEFAULT_AGENT: 'ExampleAgent',
  TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent',
  TELEGRAM_POLL_TIMEOUT_SEC: '30',
  TELEGRAM_UPDATE_LIMIT: '50',
  TELEGRAM_MAX_CONCURRENT_SCOPES: '3',
  TELEGRAM_MAX_QUEUED_TOTAL: '100',
  TELEGRAM_MAX_QUEUED_PER_SCOPE: '20',
  TELEGRAM_MAX_INBOUND_BYTES: '19922944',
  TELEGRAM_MAX_OUTBOUND_BYTES: '47185920',
  TELEGRAM_OUTBOUND_DNS: 'system',
  TELEGRAM_HISTORY_MAX_MESSAGES: '40',
  TELEGRAM_HISTORY_MAX_BYTES: '262144',
  TELEGRAM_STATE_DIR: '',
  TELEGRAM_VCP_BASE_URL: 'http://127.0.0.1:6005/v1',
  TELEGRAM_VCP_MODEL: 'VCPModelAuto',
  TELEGRAM_AGENT_MODELS: '{}',
  TELEGRAM_VCP_TEMPERATURE: '',
  TELEGRAM_VCP_MAX_TOKENS: '',
  TELEGRAM_VCP_KEY: '',
  TELEGRAM_STREAM_MODE: 'draft',
  TELEGRAM_PROACTIVE_ENABLED: 'false',
  TELEGRAM_LOG_CONTENT: 'false',
});

const INTEGER_FIELDS = Object.freeze({
  TELEGRAM_POLL_TIMEOUT_SEC: Object.freeze([1, 50]),
  TELEGRAM_UPDATE_LIMIT: Object.freeze([1, 100]),
  TELEGRAM_MAX_CONCURRENT_SCOPES: Object.freeze([1, 32]),
  TELEGRAM_MAX_QUEUED_TOTAL: Object.freeze([1, 10000]),
  TELEGRAM_MAX_QUEUED_PER_SCOPE: Object.freeze([1, 1000]),
  TELEGRAM_MAX_INBOUND_BYTES: Object.freeze([1, 19922944]),
  TELEGRAM_MAX_OUTBOUND_BYTES: Object.freeze([1, 47185920]),
  TELEGRAM_HISTORY_MAX_MESSAGES: Object.freeze([1, 200]),
  TELEGRAM_HISTORY_MAX_BYTES: Object.freeze([1, 1048576]),
});

class ConfigError extends Error {
  constructor(code, field) {
    super(CONFIG_ERROR_MESSAGE);
    Object.defineProperty(this, 'name', {
      configurable: true,
      value: 'ConfigError',
    });
    this.code = code;
    this.field = field;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ConfigError);
  }
}

function fail(code, field) {
  throw new ConfigError(code, field);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function ownKeys(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('CONFIG_INVALID', 'CONFIG');
  }

  try {
    return Object.keys(raw);
  } catch {
    fail('CONFIG_INVALID', 'CONFIG');
  }
}

function readString(raw, presentKeys, field) {
  if (!presentKeys.has(field)) return DEFAULTS[field];

  let value;
  try {
    value = raw[field];
  } catch {
    fail('CONFIG_INVALID', field);
  }

  if (typeof value !== 'string') fail('CONFIG_INVALID', field);
  return value;
}

function parseMode(value) {
  if (!['disabled', 'probe', 'enabled'].includes(value)) {
    fail('CONFIG_INVALID', 'TELEGRAM_MODE');
  }
  return value;
}

function parseBoolean(value, field) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail('CONFIG_INVALID', field);
}

function parseInteger(value, field, minimum, maximum) {
  if (!/^\d+$/.test(value)) fail('CONFIG_INVALID', field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('CONFIG_INVALID', field);
  }
  return parsed;
}

function parseIdList(value, field, allowNegative) {
  if (value === '') return [];
  const pattern = allowNegative ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/;
  const items = value.split(',');
  if (items.some((item) => !pattern.test(item))) fail('CONFIG_INVALID', field);
  return items;
}

function parseAgentList(value) {
  if (value === '') fail('CONFIG_REQUIRED', 'TELEGRAM_ALLOWED_AGENTS');
  const agents = value.split(',');
  if (agents.some((agent) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(agent))) {
    fail('CONFIG_INVALID', 'TELEGRAM_ALLOWED_AGENTS');
  }
  if (new Set(agents).size !== agents.length) {
    fail('CONFIG_INVALID', 'TELEGRAM_ALLOWED_AGENTS');
  }
  return agents;
}

function parseDefaultAgent(value, allowedAgents) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    fail(value === '' ? 'CONFIG_REQUIRED' : 'CONFIG_INVALID', 'TELEGRAM_DEFAULT_AGENT');
  }
  if (!allowedAgents.includes(value)) fail('CONFIG_INVALID', 'TELEGRAM_DEFAULT_AGENT');
  return value;
}

function parseVcpBaseUrl(value) {
  const literalLoopback = /^http:\/\/(?:127\.0\.0\.1(?::\d+)?|\[::1\](?::\d+)?)(?:\/|$)/;
  if (!literalLoopback.test(value)) fail('CONFIG_INVALID', 'TELEGRAM_VCP_BASE_URL');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('CONFIG_INVALID', 'TELEGRAM_VCP_BASE_URL');
  }

  if (
    parsed.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !['/v1', '/v1/'].includes(parsed.pathname)
  ) {
    fail('CONFIG_INVALID', 'TELEGRAM_VCP_BASE_URL');
  }

  return `${parsed.origin}/v1`;
}

function parseVcpModel(value) {
  if (value === '') fail('CONFIG_REQUIRED', 'TELEGRAM_VCP_MODEL');
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    fail('CONFIG_INVALID', 'TELEGRAM_VCP_MODEL');
  }
  return value;
}

function resolveStateDir(value, projectBasePath) {
  if (typeof projectBasePath !== 'string' || projectBasePath === '') {
    fail('CONFIG_INVALID', 'PROJECT_BASE_PATH');
  }

  const pluginRoot = path.resolve(projectBasePath, 'Plugin', 'TelegramBridge');
  const target = value === ''
    ? path.join(pluginRoot, 'state')
    : path.resolve(pluginRoot, value);
  const relative = path.relative(pluginRoot, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('CONFIG_INVALID', 'TELEGRAM_STATE_DIR');
  }
  return target;
}

function parseConfig(raw = {}, options = {}) {
  try {
    const keys = ownKeys(raw);
    for (const key of keys) {
      if (key.startsWith('TELEGRAM_') && !KNOWN_KEYS.has(key)) {
        fail('CONFIG_UNKNOWN_KEY', 'TELEGRAM_UNKNOWN');
      }
    }

    const presentKeys = new Set(keys);
    const values = {};
    for (const field of TELEGRAM_CONFIG_KEYS) {
      values[field] = readString(raw, presentKeys, field);
    }

    const mode = parseMode(values.TELEGRAM_MODE);
    const groupsEnabled = parseBoolean(values.TELEGRAM_GROUPS_ENABLED, 'TELEGRAM_GROUPS_ENABLED');
    const proactiveEnabled = parseBoolean(values.TELEGRAM_PROACTIVE_ENABLED, 'TELEGRAM_PROACTIVE_ENABLED');
    const logContent = parseBoolean(values.TELEGRAM_LOG_CONTENT, 'TELEGRAM_LOG_CONTENT');
    const allowedUserIds = parseIdList(
      values.TELEGRAM_ALLOWED_USER_IDS,
      'TELEGRAM_ALLOWED_USER_IDS',
      false,
    );
    const allowedChatIds = parseIdList(
      values.TELEGRAM_ALLOWED_CHAT_IDS,
      'TELEGRAM_ALLOWED_CHAT_IDS',
      true,
    );
    const allowedAgents = parseAgentList(values.TELEGRAM_ALLOWED_AGENTS);
    const defaultAgent = parseDefaultAgent(values.TELEGRAM_DEFAULT_AGENT, allowedAgents);
    let agentModels;
    try {
      if (values.TELEGRAM_AGENT_MODELS.length > 8192) throw new Error();
      agentModels = JSON.parse(values.TELEGRAM_AGENT_MODELS || '{}');
      if (!agentModels || Array.isArray(agentModels) || typeof agentModels !== 'object') throw new Error();
      for (const [agent, model] of Object.entries(agentModels)) {
        if (!allowedAgents.includes(agent) || typeof model !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(model)) throw new Error();
      }
    } catch { fail('CONFIG_INVALID', 'TELEGRAM_AGENT_MODELS'); }
    const temperatureText = values.TELEGRAM_VCP_TEMPERATURE;
    const vcpTemperature = temperatureText === '' ? null : Number(temperatureText);
    if (vcpTemperature !== null && (!/^[0-2](?:\.\d+)?$/.test(temperatureText) || vcpTemperature > 2)) {
      fail('CONFIG_INVALID','TELEGRAM_VCP_TEMPERATURE');
    }
    const vcpMaxTokens = values.TELEGRAM_VCP_MAX_TOKENS === '' ? null
      : parseInteger(values.TELEGRAM_VCP_MAX_TOKENS, 'TELEGRAM_VCP_MAX_TOKENS', 1, 131072);

    if (groupsEnabled && allowedUserIds.length === 0) {
      fail('CONFIG_REQUIRED', 'TELEGRAM_ALLOWED_USER_IDS');
    }
    if (groupsEnabled && allowedChatIds.length === 0) {
      fail('CONFIG_REQUIRED', 'TELEGRAM_ALLOWED_CHAT_IDS');
    }
    if (mode !== 'disabled' && values.TELEGRAM_BOT_TOKEN.trim() === '') {
      fail('CONFIG_REQUIRED', 'TELEGRAM_BOT_TOKEN');
    }
    if (mode !== 'disabled' && allowedUserIds.length === 0) {
      fail('CONFIG_REQUIRED', 'TELEGRAM_ALLOWED_USER_IDS');
    }
    if (mode !== 'disabled' && values.TELEGRAM_VCP_KEY.trim() === '') {
      fail('CONFIG_REQUIRED', 'TELEGRAM_VCP_KEY');
    }
    if (options.production === true && logContent) {
      fail('CONFIG_FORBIDDEN', 'TELEGRAM_LOG_CONTENT');
    }

    const integers = {};
    for (const [field, [minimum, maximum]] of Object.entries(INTEGER_FIELDS)) {
      integers[field] = parseInteger(values[field], field, minimum, maximum);
    }

    const streamMode = values.TELEGRAM_STREAM_MODE;
    if (!['draft', 'edit'].includes(streamMode)) {
      fail('CONFIG_INVALID', 'TELEGRAM_STREAM_MODE');
    }
    const outboundDns = values.TELEGRAM_OUTBOUND_DNS;
    if (!['system', 'cloudflare'].includes(outboundDns)) {
      fail('CONFIG_INVALID', 'TELEGRAM_OUTBOUND_DNS');
    }
    if (integers.TELEGRAM_MAX_QUEUED_PER_SCOPE > integers.TELEGRAM_MAX_QUEUED_TOTAL) {
      fail('CONFIG_INVALID', 'TELEGRAM_MAX_QUEUED_PER_SCOPE');
    }

    const fallbackProjectBase = path.resolve(__dirname, '..', '..', '..');
    const stateDir = resolveStateDir(
      values.TELEGRAM_STATE_DIR,
      options.projectBasePath ?? fallbackProjectBase,
    );

    return deepFreeze({
      mode,
      botToken: values.TELEGRAM_BOT_TOKEN,
      allowedUserIds,
      allowedChatIds,
      groupsEnabled,
      defaultAgent,
      allowedAgents,
      pollTimeoutSec: integers.TELEGRAM_POLL_TIMEOUT_SEC,
      updateLimit: integers.TELEGRAM_UPDATE_LIMIT,
      maxConcurrentScopes: integers.TELEGRAM_MAX_CONCURRENT_SCOPES,
      maxQueuedTotal: integers.TELEGRAM_MAX_QUEUED_TOTAL,
      maxQueuedPerScope: integers.TELEGRAM_MAX_QUEUED_PER_SCOPE,
      maxInboundBytes: integers.TELEGRAM_MAX_INBOUND_BYTES,
      maxOutboundBytes: integers.TELEGRAM_MAX_OUTBOUND_BYTES,
      outboundDns,
      historyMaxMessages: integers.TELEGRAM_HISTORY_MAX_MESSAGES,
      historyMaxBytes: integers.TELEGRAM_HISTORY_MAX_BYTES,
      stateDir,
      vcpBaseUrl: parseVcpBaseUrl(values.TELEGRAM_VCP_BASE_URL),
      vcpModel: parseVcpModel(values.TELEGRAM_VCP_MODEL),
      agentModels,
      vcpTemperature,
      vcpMaxTokens,
      vcpKey: values.TELEGRAM_VCP_KEY,
      streamMode,
      proactiveEnabled,
      logContent,
      production: options.production === true,
    });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('CONFIG_INVALID', 'CONFIG');
  }
}

module.exports = {
  ConfigError,
  TELEGRAM_CONFIG_KEYS,
  parseConfig,
};
