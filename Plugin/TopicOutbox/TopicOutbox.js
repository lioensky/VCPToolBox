const path = require('path');
const { TopicOutboxStore, cloneJson, nowIso } = require('./topicOutboxStore');

const STATUS = Object.freeze({
  PENDING: 'pending',
  DELIVERING: 'delivering',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
});

const OPERATION = Object.freeze({
  CREATE_TOPIC: 'CreateTopic',
  REPLY_TO_TOPIC: 'ReplyToTopic'
});

const DEFAULT_CONFIG = Object.freeze({
  maxPending: 500,
  maxMessageChars: 12000,
  defaultTtlDays: 30,
  enableImmediateDelivery: true,
  deliveryLockSeconds: 120,
  maxDeliveryAttempts: 3,
  drainBatchSize: 20
});

let store = null;
let pluginManager = null;
let toolsChangedHandler = null;
let configState = { ...DEFAULT_CONFIG };
let initialized = false;
let shuttingDown = false;
let drainInProgress = false;
let drainQueued = false;

async function initialize(config = {}, dependencies = {}) {
  await shutdown();

  shuttingDown = false;
  configState = parseConfig(config);
  store = new TopicOutboxStore({
    storePath: configState.storePath,
    backupOnWrite: true
  });
  await store.initialize();

  pluginManager = dependencies.pluginManager || null;
  if (pluginManager && typeof pluginManager.on === 'function') {
    toolsChangedHandler = event => {
      if (event && event.reason === 'distributed_register') {
        drainPending({ reason: 'distributed_register' }).catch(error => {
          console.error(`[TopicOutbox] Auto drain failed: ${error.message}`);
        });
      }
    };
    pluginManager.on('tools_changed', toolsChangedHandler);
  } else {
    console.warn('[TopicOutbox] pluginManager dependency is unavailable; automatic drain is disabled.');
  }

  initialized = true;

  if (isTopicSponsorAvailable()) {
    setImmediate(() => {
      drainPending({ reason: 'startup' }).catch(error => {
        console.error(`[TopicOutbox] Startup drain failed: ${error.message}`);
      });
    });
  }

  console.log('[TopicOutbox] Initialized.');
}

async function shutdown() {
  shuttingDown = true;

  if (pluginManager && toolsChangedHandler && typeof pluginManager.off === 'function') {
    pluginManager.off('tools_changed', toolsChangedHandler);
  } else if (pluginManager && toolsChangedHandler && typeof pluginManager.removeListener === 'function') {
    pluginManager.removeListener('tools_changed', toolsChangedHandler);
  }

  toolsChangedHandler = null;
  pluginManager = null;
  initialized = false;
  drainInProgress = false;
  drainQueued = false;
}

async function processToolCall(args = {}) {
  await ensureInitialized();

  const command = String(args.command || '').trim();
  switch (command) {
    case 'CreateTopicRequest':
      return handleCreateTopicRequest(args);
    case 'ReplyToTopicRequest':
      return handleReplyToTopicRequest(args);
    case 'ListTopicRequests':
      return handleListTopicRequests(args);
    case 'CancelTopicRequest':
      return handleCancelTopicRequest(args);
    default:
      throw new Error(`Unknown TopicOutbox command: ${command || '(empty)'}`);
  }
}

async function handleCreateTopicRequest(args) {
  const record = buildBaseRecord(args, OPERATION.CREATE_TOPIC, {
    topic_name: requireString(args.topic_name, 'topic_name', 200),
    initial_message: requireString(args.initial_message, 'initial_message', configState.maxMessageChars)
  });

  const result = await saveIdempotentRecord(record);
  await maybeImmediateDrain();

  const latest = await store.getRequest(record.topicRequestId);
  return {
    status: 'success',
    command: 'CreateTopicRequest',
    idempotent: result.idempotent,
    message: latest.status === STATUS.DELIVERED ? '话题创建请求已投递。' : '话题创建请求已保存到 TopicOutbox。',
    topicRequest: latest
  };
}

async function handleReplyToTopicRequest(args) {
  const senderName = args.sender_name || args.senderName;
  const record = buildBaseRecord(args, OPERATION.REPLY_TO_TOPIC, {
    topic_id: requireString(args.topic_id || args.topicId, 'topic_id', 200),
    message: requireString(args.message, 'message', configState.maxMessageChars),
    sender_name: requireString(senderName, 'sender_name', 120)
  });

  const result = await saveIdempotentRecord(record);
  await maybeImmediateDrain();

  const latest = await store.getRequest(record.topicRequestId);
  return {
    status: 'success',
    command: 'ReplyToTopicRequest',
    idempotent: result.idempotent,
    message: latest.status === STATUS.DELIVERED ? '话题回复请求已投递。' : '话题回复请求已保存到 TopicOutbox。',
    topicRequest: latest
  };
}

async function handleListTopicRequests(args) {
  const requests = await store.listRequests({
    status: optionalString(args.status),
    maid: optionalString(args.maid),
    operation: optionalString(args.operation),
    limit: args.limit
  });
  const stats = await store.getStats();

  return {
    status: 'success',
    command: 'ListTopicRequests',
    count: requests.length,
    stats,
    requests
  };
}

async function handleCancelTopicRequest(args) {
  const topicRequestId = normalizeRequestId(args.topicRequestId || args.request_id);
  let cancelledRecord = null;

  await store.transaction(data => {
    const record = data.requests.find(item => item.topicRequestId === topicRequestId);
    if (!record) {
      throw new Error(`Topic request not found: ${topicRequestId}`);
    }

    if (record.status === STATUS.DELIVERED) {
      throw new Error(`Topic request already delivered and cannot be cancelled: ${topicRequestId}`);
    }
    if (record.status === STATUS.EXPIRED) {
      throw new Error(`Topic request already expired and cannot be cancelled: ${topicRequestId}`);
    }
    if (record.status === STATUS.DELIVERING && !isLockExpired(record)) {
      throw new Error(`Topic request is currently delivering and cannot be cancelled yet: ${topicRequestId}`);
    }

    record.status = STATUS.CANCELLED;
    record.lockUntil = null;
    record.updatedAt = nowIso();
    cancelledRecord = cloneJson(record);
    return cancelledRecord;
  });

  return {
    status: 'success',
    command: 'CancelTopicRequest',
    message: 'TopicOutbox 请求已取消。',
    topicRequest: cancelledRecord
  };
}

async function drainPending(options = {}) {
  await ensureInitialized();

  if (shuttingDown) {
    return { status: 'success', skipped: true, reason: 'TopicOutbox is shutting down.' };
  }

  if (drainInProgress) {
    drainQueued = true;
    return { status: 'success', skipped: true, reason: 'Drain already in progress.' };
  }

  drainInProgress = true;
  const summary = {
    status: 'success',
    reason: options.reason || 'manual',
    delivered: 0,
    failed: 0,
    expired: 0,
    skipped: 0,
    unavailable: false
  };

  try {
    do {
      drainQueued = false;
      const lifecycle = await refreshLifecycleState();
      summary.expired += lifecycle.expired;

      if (!isTopicSponsorAvailable()) {
        summary.unavailable = true;
        break;
      }

      const candidates = await claimDeliveryBatch();
      if (candidates.length === 0) {
        break;
      }

      for (const record of candidates) {
        try {
          const deliveryResult = await deliverRecord(record);
          await markDelivered(record.topicRequestId, deliveryResult);
          summary.delivered += 1;
        } catch (error) {
          await markFailed(record.topicRequestId, error);
          summary.failed += 1;
        }
      }
    } while (drainQueued);

    return summary;
  } finally {
    drainInProgress = false;
  }
}

async function saveIdempotentRecord(record) {
  let outcome = null;

  await store.transaction(data => {
    const existing = data.requests.find(item => item.topicRequestId === record.topicRequestId);
    if (existing) {
      if (!hasSameCorePayload(existing, record)) {
        throw new Error(`topicRequestId conflict: ${record.topicRequestId} already exists with different payload.`);
      }
      outcome = { idempotent: true, record: cloneJson(existing) };
      return outcome;
    }

    const activeCount = data.requests.filter(item => {
      return [STATUS.PENDING, STATUS.DELIVERING, STATUS.FAILED].includes(item.status);
    }).length;

    if (activeCount >= configState.maxPending) {
      throw new Error(`TopicOutbox pending limit reached: ${configState.maxPending}`);
    }

    data.requests.push(record);
    outcome = { idempotent: false, record: cloneJson(record) };
    return outcome;
  });

  return outcome;
}

async function maybeImmediateDrain() {
  if (!configState.enableImmediateDelivery || !isTopicSponsorAvailable()) {
    return;
  }
  await drainPending({ reason: 'immediate_delivery' });
}

async function refreshLifecycleState() {
  const nowMs = Date.now();
  let expired = 0;
  let recovered = 0;

  await store.transaction(data => {
    for (const record of data.requests) {
      if ([STATUS.DELIVERED, STATUS.CANCELLED, STATUS.EXPIRED].includes(record.status)) {
        continue;
      }

      if (isRecordExpired(record, nowMs)) {
        record.status = STATUS.EXPIRED;
        record.lockUntil = null;
        record.updatedAt = nowIso();
        record.lastError = 'TopicOutbox request expired before delivery.';
        expired += 1;
        continue;
      }

      if (record.status === STATUS.DELIVERING && isLockExpired(record, nowMs)) {
        record.status = record.attempts >= record.maxAttempts ? STATUS.FAILED : STATUS.FAILED;
        record.lockUntil = null;
        record.updatedAt = nowIso();
        record.lastError = 'Delivery lock expired before a final result was recorded.';
        recovered += 1;
      }
    }
    return { expired, recovered };
  });

  return { expired, recovered };
}

async function claimDeliveryBatch() {
  const claimed = [];
  const now = Date.now();
  const lockUntil = new Date(now + configState.deliveryLockSeconds * 1000).toISOString();

  await store.transaction(data => {
    const candidates = data.requests
      .filter(record => isDeliveryCandidate(record, now))
      .sort(compareDeliveryPriority)
      .slice(0, configState.drainBatchSize);

    for (const record of candidates) {
      record.status = STATUS.DELIVERING;
      record.attempts = safeInteger(record.attempts) + 1;
      record.lastAttemptAt = nowIso();
      record.lockUntil = lockUntil;
      record.updatedAt = nowIso();
      claimed.push(cloneJson(record));
    }

    return claimed;
  });

  return claimed;
}

async function deliverRecord(record) {
  const args = record.operation === OPERATION.CREATE_TOPIC
    ? {
        command: 'CreateTopic',
        maid: record.maid,
        topic_name: record.payload.topic_name,
        initial_message: record.payload.initial_message
      }
    : {
        command: 'ReplyToTopic',
        maid: record.maid,
        topic_id: record.payload.topic_id,
        message: record.payload.message,
        sender_name: record.payload.sender_name
      };

  const result = await pluginManager.processToolCall('TopicSponsor', args);
  if (isToolFailure(result)) {
    throw new Error(formatToolFailure(result));
  }

  return result;
}

async function markDelivered(topicRequestId, deliveryResult) {
  await store.transaction(data => {
    const record = data.requests.find(item => item.topicRequestId === topicRequestId);
    if (!record) {
      return null;
    }

    const normalizedResult = unwrapToolResult(deliveryResult);
    record.status = STATUS.DELIVERED;
    record.lockUntil = null;
    record.lastError = null;
    record.updatedAt = nowIso();
    record.delivery = {
      deliveredAt: nowIso(),
      targetTool: 'TopicSponsor',
      targetCommand: record.operation,
      result: deliveryResult,
      deliveredTopicId: normalizedResult.topic_id || record.payload.topic_id || null,
      messageId: normalizedResult.message_id || null
    };
    return record;
  });
}

async function markFailed(topicRequestId, error) {
  await store.transaction(data => {
    const record = data.requests.find(item => item.topicRequestId === topicRequestId);
    if (!record) {
      return null;
    }

    record.status = isRecordExpired(record) ? STATUS.EXPIRED : STATUS.FAILED;
    record.lockUntil = null;
    record.lastError = error && error.message ? error.message : String(error || 'Unknown delivery error');
    record.updatedAt = nowIso();
    return record;
  });
}

function buildBaseRecord(args, operation, payload) {
  const topicRequestId = normalizeRequestId(args.topicRequestId || args.request_id);
  const maid = requireString(args.maid, 'maid', 120);
  enforceAllowedMaid(maid);

  const createdAt = nowIso();
  const expiresAt = normalizeExpiresAt(args.expires_at || args.expiresAt);
  const maxAttempts = normalizeInteger(args.maxAttempts, configState.maxDeliveryAttempts, 1, 20);

  return {
    topicRequestId,
    operation,
    targetTool: 'TopicSponsor',
    status: STATUS.PENDING,
    maid,
    priority: normalizePriority(args.priority),
    expires_at: expiresAt,
    createdAt,
    updatedAt: createdAt,
    attempts: 0,
    maxAttempts,
    lastAttemptAt: null,
    lastError: null,
    lockUntil: null,
    metadata: normalizeMetadata(args.metadata),
    payload,
    delivery: null
  };
}

function parseConfig(config = {}) {
  return {
    storePath: resolveStorePath(config.TOPIC_OUTBOX_STORE_PATH),
    maxPending: normalizeInteger(config.TOPIC_OUTBOX_MAX_PENDING, DEFAULT_CONFIG.maxPending, 1, 10000),
    maxMessageChars: normalizeInteger(config.TOPIC_OUTBOX_MAX_MESSAGE_CHARS, DEFAULT_CONFIG.maxMessageChars, 1, 200000),
    defaultTtlDays: normalizeInteger(config.TOPIC_OUTBOX_DEFAULT_TTL_DAYS, DEFAULT_CONFIG.defaultTtlDays, 1, 3650),
    allowedTargetAgents: parseCsv(config.TOPIC_OUTBOX_ALLOWED_TARGET_AGENTS),
    enableImmediateDelivery: normalizeBoolean(config.TOPIC_OUTBOX_ENABLE_IMMEDIATE_DELIVERY, DEFAULT_CONFIG.enableImmediateDelivery),
    deliveryLockSeconds: normalizeInteger(config.TOPIC_OUTBOX_DELIVERY_LOCK_SECONDS, DEFAULT_CONFIG.deliveryLockSeconds, 10, 3600),
    maxDeliveryAttempts: normalizeInteger(config.TOPIC_OUTBOX_MAX_DELIVERY_ATTEMPTS, DEFAULT_CONFIG.maxDeliveryAttempts, 1, 20),
    drainBatchSize: normalizeInteger(config.TOPIC_OUTBOX_DRAIN_BATCH_SIZE, DEFAULT_CONFIG.drainBatchSize, 1, 200)
  };
}

function resolveStorePath(value) {
  const configured = optionalString(value);
  if (!configured) {
    return path.join(__dirname, 'data', 'topic_requests.json');
  }
  return path.isAbsolute(configured) ? configured : path.join(__dirname, configured);
}

function normalizeRequestId(value) {
  const id = requireString(value, 'topicRequestId', 200);
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('topicRequestId cannot contain control characters.');
  }
  return id;
}

function requireString(value, fieldName, maxLength) {
  if (value === undefined || value === null) {
    throw new Error(`Missing required field: ${fieldName}`);
  }
  const text = String(value).trim();
  if (!text) {
    throw new Error(`Field ${fieldName} cannot be empty.`);
  }
  if (text.length > maxLength) {
    throw new Error(`Field ${fieldName} exceeds max length ${maxLength}.`);
  }
  return text;
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function normalizeMetadata(value) {
  if (value === undefined || value === null || value === '') {
    return {};
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      throw new Error(`metadata must be a JSON object string: ${error.message}`);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cloneJson(value);
  }
  throw new Error('metadata must be an object.');
}

function normalizeExpiresAt(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return new Date(Date.now() + configState.defaultTtlDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid expires_at value: ${value}`);
  }
  return new Date(parsed).toISOString();
}

function normalizePriority(value) {
  const priority = optionalString(value).toLowerCase();
  return ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
}

function normalizeBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeInteger(value, defaultValue, min, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

function safeInteger(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(value) {
  return optionalString(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function enforceAllowedMaid(maid) {
  if (configState.allowedTargetAgents.length === 0) {
    return;
  }
  if (!configState.allowedTargetAgents.includes(maid)) {
    throw new Error(`Target agent is not allowed by TopicOutbox config: ${maid}`);
  }
}

function hasSameCorePayload(existing, incoming) {
  return stableStringify({
    operation: existing.operation,
    maid: existing.maid,
    payload: existing.payload
  }) === stableStringify({
    operation: incoming.operation,
    maid: incoming.maid,
    payload: incoming.payload
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isTopicSponsorAvailable() {
  if (!pluginManager || typeof pluginManager.getPlugin !== 'function') {
    return false;
  }
  const plugin = pluginManager.getPlugin('TopicSponsor');
  return Boolean(plugin && plugin.isDistributed);
}

function isDeliveryCandidate(record, nowMs = Date.now()) {
  if (!record || [STATUS.DELIVERED, STATUS.CANCELLED, STATUS.EXPIRED].includes(record.status)) {
    return false;
  }
  if (![STATUS.PENDING, STATUS.FAILED].includes(record.status)) {
    return false;
  }
  if (safeInteger(record.attempts) >= safeInteger(record.maxAttempts)) {
    return false;
  }
  return !isRecordExpired(record, nowMs);
}

function isRecordExpired(record, nowMs = Date.now()) {
  const expiresAt = Date.parse(record.expires_at || '');
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function isLockExpired(record, nowMs = Date.now()) {
  const lockUntil = Date.parse(record.lockUntil || '');
  return !Number.isFinite(lockUntil) || lockUntil <= nowMs;
}

function compareDeliveryPriority(a, b) {
  const priorityRank = { high: 3, normal: 2, low: 1 };
  const rankDelta = (priorityRank[b.priority] || 2) - (priorityRank[a.priority] || 2);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  const aTime = Date.parse(a.createdAt || 0) || 0;
  const bTime = Date.parse(b.createdAt || 0) || 0;
  return aTime - bTime;
}

function unwrapToolResult(result) {
  if (result && typeof result === 'object' && result.status === 'success' && result.result) {
    return result.result;
  }
  return result && typeof result === 'object' ? result : {};
}

function isToolFailure(result) {
  return Boolean(result && typeof result === 'object' && (
    result.status === 'error' ||
    result.error ||
    result.plugin_error ||
    result.plugin_execution_error
  ));
}

function formatToolFailure(result) {
  return result.error ||
    result.plugin_error ||
    result.plugin_execution_error ||
    result.message ||
    JSON.stringify(result);
}

async function ensureInitialized() {
  if (initialized && store) {
    return;
  }
  await initialize({}, {});
}

module.exports = {
  initialize,
  shutdown,
  processToolCall,
  drainPending,
  _private: {
    STATUS,
    OPERATION,
    parseConfig,
    hasSameCorePayload,
    isDeliveryCandidate
  }
};
