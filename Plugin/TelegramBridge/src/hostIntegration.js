'use strict';

const ERROR_MESSAGE = 'VCP host integration operation failed.';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const EXPECTED_CAPABILITIES = Object.freeze({
  hostIntegrationVersion: 1,
  approvalCorrelationVersion: 1,
  asyncCorrelationVersion: 1,
  approvalResponseMethod: 'handleApprovalResponse',
});

class HostIntegrationError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'HostIntegrationError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, HostIntegrationError);
  }
}

function fail(code) {
  throw new HostIntegrationError(code);
}

function readOnce(record, keys, code) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) fail(code);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(record); } catch { fail(code); }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      result[key] = undefined;
      continue;
    }
    if (Object.hasOwn(descriptor, 'value')) result[key] = descriptor.value;
    else {
      try { result[key] = Reflect.apply(descriptor.get, record, []); }
      catch { fail(code); }
    }
  }
  return result;
}

function snapshotCapabilities(value) {
  const data = readOnce(value, Object.keys(EXPECTED_CAPABILITIES), 'HOST_INTEGRATION_UNAVAILABLE');
  for (const [key, expected] of Object.entries(EXPECTED_CAPABILITIES)) {
    if (data[key] !== expected) fail('HOST_INTEGRATION_UNAVAILABLE');
  }
  return EXPECTED_CAPABILITIES;
}

function snapshotApprovalEvent(value) {
  const event = readOnce(value, ['type', 'data'], 'HOST_EVENT_INVALID');
  if (event.type !== 'tool_approval_request') fail('HOST_EVENT_INVALID');
  const data = readOnce(event.data, [
    'requestId', 'parentRequestId', 'parentMessageId', 'correlationVersion',
    'toolName', 'timestamp', 'approvalTtlMs',
  ], 'HOST_EVENT_INVALID');
  if (
    typeof data.requestId !== 'string' || !ID_PATTERN.test(data.requestId)
    || typeof data.parentRequestId !== 'string' || !ID_PATTERN.test(data.parentRequestId)
    || typeof data.parentMessageId !== 'string' || !ID_PATTERN.test(data.parentMessageId)
    || data.correlationVersion !== 1
    || typeof data.toolName !== 'string' || !TOOL_PATTERN.test(data.toolName)
    || typeof data.timestamp !== 'string' || data.timestamp.length > 128
    || !Number.isSafeInteger(data.approvalTtlMs) || data.approvalTtlMs < 1 || data.approvalTtlMs > 3_600_000
  ) fail('HOST_EVENT_INVALID');
  return Object.freeze({
    type: 'tool_approval_request',
    data: Object.freeze({
      requestId: data.requestId,
      parentRequestId: data.parentRequestId,
      parentMessageId: data.parentMessageId,
      correlationVersion: 1,
      toolName: data.toolName,
      timestamp: data.timestamp,
      approvalTtlMs: data.approvalTtlMs,
    }),
  });
}

function snapshotAsyncEvent(value, expectedType) {
  const event = readOnce(value, ['type', 'data'], 'HOST_EVENT_INVALID');
  if (event.type !== expectedType) fail('HOST_EVENT_INVALID');
  const fields = expectedType === 'async_task_receipt'
    ? ['correlationVersion', 'pluginName', 'taskId', 'parentRequestId', 'parentMessageId']
    : ['correlationVersion', 'pluginName', 'taskId', 'parentRequestId'];
  const data = readOnce(event.data, fields, 'HOST_EVENT_INVALID');
  if (
    data.correlationVersion !== 1
    || typeof data.pluginName !== 'string' || !TOOL_PATTERN.test(data.pluginName)
    || typeof data.taskId !== 'string' || !ID_PATTERN.test(data.taskId)
    || (expectedType === 'async_task_receipt' && (
      typeof data.parentRequestId !== 'string' || !ID_PATTERN.test(data.parentRequestId)
      || typeof data.parentMessageId !== 'string' || !ID_PATTERN.test(data.parentMessageId)
    ))
    || (expectedType === 'async_task_completed' && data.parentRequestId !== undefined
      && (typeof data.parentRequestId !== 'string' || !ID_PATTERN.test(data.parentRequestId)))
  ) fail('HOST_EVENT_INVALID');
  return Object.freeze({
    type: expectedType,
    data: Object.freeze({
      correlationVersion: 1,
      pluginName: data.pluginName,
      taskId: data.taskId,
      ...(data.parentRequestId === undefined ? {} : { parentRequestId: data.parentRequestId }),
      ...(data.parentMessageId === undefined ? {} : { parentMessageId: data.parentMessageId }),
    }),
  });
}

function createHostIntegration(options = {}) {
  let pluginManager;
  let onApproval;
  let onAsyncReceipt;
  let onAsyncCompleted;
  try {
    pluginManager = options.pluginManager;
    onApproval = options.onApproval;
    onAsyncReceipt = options.onAsyncReceipt;
    onAsyncCompleted = options.onAsyncCompleted;
  } catch { fail('HOST_INTEGRATION_CONFIG_INVALID'); }
  if (
    !pluginManager
    || typeof pluginManager.getIntegrationCapabilities !== 'function'
    || typeof pluginManager.handleApprovalResponse !== 'function'
    || typeof pluginManager.on !== 'function'
    || typeof pluginManager.removeListener !== 'function'
    || typeof onApproval !== 'function'
    || (onAsyncReceipt !== undefined && typeof onAsyncReceipt !== 'function')
    || (onAsyncCompleted !== undefined && typeof onAsyncCompleted !== 'function')
  ) fail('HOST_INTEGRATION_CONFIG_INVALID');
  let started = false;
  let lastErrorCode = null;

  function probe() {
    try {
      return snapshotCapabilities(pluginManager.getIntegrationCapabilities());
    } catch (error) {
      if (error instanceof HostIntegrationError) throw error;
      fail('HOST_INTEGRATION_UNAVAILABLE');
    }
  }

  function dispatchHandler(handler, snapshotter, rawEvent, failureCode) {
    let event;
    try { event = snapshotter(rawEvent); }
    catch {
      lastErrorCode = 'HOST_EVENT_INVALID';
      return;
    }
    let result;
    try { result = handler(event); }
    catch {
      lastErrorCode = failureCode;
      return;
    }
    try {
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => { lastErrorCode = failureCode; });
      }
    } catch {
      lastErrorCode = failureCode;
    }
  }

  const approvalListener = (rawEvent) => dispatchHandler(
    onApproval, snapshotApprovalEvent, rawEvent, 'HOST_APPROVAL_HANDLER_FAILED',
  );
  const asyncReceiptListener = (rawEvent) => dispatchHandler(
    onAsyncReceipt,
    (event) => snapshotAsyncEvent(event, 'async_task_receipt'),
    rawEvent,
    'HOST_ASYNC_HANDLER_FAILED',
  );
  const asyncCompletedListener = (rawEvent) => dispatchHandler(
    onAsyncCompleted,
    (event) => snapshotAsyncEvent(event, 'async_task_completed'),
    rawEvent,
    'HOST_ASYNC_HANDLER_FAILED',
  );

  function start() {
    probe();
    if (started) return false;
    pluginManager.on('tool_approval_request', approvalListener);
    if (onAsyncReceipt) pluginManager.on('async_task_receipt', asyncReceiptListener);
    if (onAsyncCompleted) pluginManager.on('async_task_completed', asyncCompletedListener);
    started = true;
    return true;
  }

  function stop() {
    if (!started) return false;
    pluginManager.removeListener('tool_approval_request', approvalListener);
    if (onAsyncReceipt) pluginManager.removeListener('async_task_receipt', asyncReceiptListener);
    if (onAsyncCompleted) pluginManager.removeListener('async_task_completed', asyncCompletedListener);
    started = false;
    return true;
  }

  function respondApproval(approvalRequestId, approved) {
    if (
      typeof approvalRequestId !== 'string' || !ID_PATTERN.test(approvalRequestId)
      || typeof approved !== 'boolean'
    ) fail('HOST_APPROVAL_RESPONSE_INVALID');
    try {
      return pluginManager.handleApprovalResponse(
        approvalRequestId,
        approved,
        'Handled by authorized Telegram owner',
      ) === true;
    } catch {
      fail('HOST_APPROVAL_RESPONSE_FAILED');
    }
  }

  function snapshot() {
    return Object.freeze({ started, lastErrorCode });
  }

  return Object.freeze({ probe, respondApproval, snapshot, start, stop });
}

module.exports = Object.freeze({
  HostIntegrationError,
  createHostIntegration,
});
