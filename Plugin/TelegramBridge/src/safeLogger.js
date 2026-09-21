'use strict';

const crypto = require('node:crypto');

const SAFE_FIELD_ALLOWLIST = Object.freeze([
  'mode',
  'status',
  'agent',
  'timing_ms',
  'duration_ms',
  'count',
  'mime',
  'size_bytes',
  'tool',
  'risk',
  'approval_status',
  'http_status',
  'error_code',
  'retryable',
  'queue_depth',
  'queue_wait_ms',
  'attempt',
  'user_hash',
  'chat_hash',
  'scope_hash',
  'request_hash',
  'task_hash',
  'delivery_hash',
]);

const SAFE_FIELD_SET = new Set(SAFE_FIELD_ALLOWLIST);
const HASH_FIELDS = new Set([
  'user_hash',
  'chat_hash',
  'scope_hash',
  'request_hash',
  'task_hash',
  'delivery_hash',
]);
const NUMBER_FIELDS = new Set([
  'timing_ms',
  'duration_ms',
  'count',
  'size_bytes',
  'http_status',
  'queue_depth',
  'queue_wait_ms',
  'attempt',
]);
const EVENT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const FIXED_FALLBACK_RECORD = Object.freeze({
  level: 'error',
  event_code: 'logger_sink_failed',
});
const INVALID_EVENT_RECORD = Object.freeze({
  level: 'warn',
  event_code: 'logger_event_rejected',
});

function normalizeSecrets(knownSecrets, hmacKey) {
  const secrets = [];
  if (Array.isArray(knownSecrets)) {
    for (const value of knownSecrets) {
      if (typeof value === 'string' && value.length > 0) secrets.push(value);
    }
  }
  if (typeof hmacKey === 'string' && hmacKey.length > 0) secrets.push(hmacKey);
  return secrets;
}

function containsSensitiveString(value, knownSecrets) {
  const lower = value.toLowerCase();
  if (knownSecrets.some((secret) => lower.includes(secret.toLowerCase()))) return true;
  if (/^data:/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]/.test(value) || value.includes('\\')) return true;
  if (/(?:^|[^0-9])-?[1-9]\d{5,}(?:$|[^0-9])/.test(value)) return true;
  if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(value)) return true;
  if (/^[A-Za-z0-9_-]{24,}={0,2}$/.test(value)) return true;
  if (/\b(?:authorization|bearer|password|secret|token|api[_-]?key)\b/i.test(value)) return true;
  return false;
}

function sanitizeField(field, value, knownSecrets) {
  if (HASH_FIELDS.has(field)) {
    return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
      ? value
      : undefined;
  }
  if (NUMBER_FIELDS.has(field)) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  }
  if (field === 'retryable') return typeof value === 'boolean' ? value : undefined;
  if (typeof value !== 'string' || containsSensitiveString(value, knownSecrets)) return undefined;
  if (field === 'mime') return SAFE_MIME_PATTERN.test(value) ? value : undefined;
  return SAFE_LABEL_PATTERN.test(value) ? value : undefined;
}

function safeOwnDataValue(fields, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function buildRecord(level, eventCode, fields, knownSecrets) {
  if (!EVENT_CODE_PATTERN.test(eventCode) || containsSensitiveString(eventCode, knownSecrets)) {
    return INVALID_EVENT_RECORD;
  }
  const record = { level, event_code: eventCode };
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return Object.freeze(record);
  }

  for (const field of SAFE_FIELD_ALLOWLIST) {
    if (!SAFE_FIELD_SET.has(field)) continue;
    const safeValue = sanitizeField(field, safeOwnDataValue(fields, field), knownSecrets);
    if (safeValue !== undefined) record[field] = safeValue;
  }
  return Object.freeze(record);
}

function createSafeLogger({ sink, fallbackSink, hmacKey, knownSecrets = [] } = {}) {
  if (!(
    (typeof hmacKey === 'string' && hmacKey.length > 0)
    || (Buffer.isBuffer(hmacKey) && hmacKey.length > 0)
  )) {
    throw new TypeError('Safe logger requires an HMAC key.');
  }

  const output = typeof sink === 'function' ? sink : () => {};
  const fallback = typeof fallbackSink === 'function' ? fallbackSink : () => {};
  const secrets = normalizeSecrets(knownSecrets, hmacKey);

  function invokeFallback() {
    try {
      Promise.resolve(fallback(FIXED_FALLBACK_RECORD)).catch(() => {});
    } catch {
      // A fallback logger is best-effort and must stay isolated.
    }
  }

  function emit(level, eventCode, fields) {
    const safeEventCode = typeof eventCode === 'string' ? eventCode : '';
    const record = buildRecord(level, safeEventCode, fields, secrets);
    try {
      Promise.resolve(output(record)).catch(invokeFallback);
    } catch {
      invokeFallback();
    }
  }

  function hashId(kind, rawId) {
    if (
      typeof kind !== 'string'
      || !/^[a-z][a-z0-9_]{0,31}$/.test(kind)
      || typeof rawId !== 'string'
      || rawId.length === 0
    ) {
      throw new TypeError('Safe logger requires canonical identifier strings.');
    }
    return crypto
      .createHmac('sha256', hmacKey)
      .update(kind)
      .update('\0')
      .update(rawId)
      .digest('hex')
      .slice(0, 16);
  }

  return Object.freeze({
    info: (eventCode, fields) => emit('info', eventCode, fields),
    warn: (eventCode, fields) => emit('warn', eventCode, fields),
    error: (eventCode, fields) => emit('error', eventCode, fields),
    hashId,
  });
}

module.exports = {
  SAFE_FIELD_ALLOWLIST,
  createSafeLogger,
};
