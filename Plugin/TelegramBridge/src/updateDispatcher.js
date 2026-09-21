'use strict';

const { types: { isPromise } } = require('node:util');

const { AccessPolicyError, normalizeTelegramId } = require('./accessPolicy');
const { orderingKeyFor } = require('./scopeQueue');

const DISPATCH_ERROR_MESSAGE = 'Telegram update dispatch failed.';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9_]*)(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;
const TASK_STATUS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RETRYABLE_REQUEST_STATUSES = new Set(['retryable_failed', 'needs_review']);
const SUPPORTED_REPLAY_POLICIES = new Set(['safe', 'idempotent', 'manual']);
const ACCESS_KINDS = new Set(['message', 'native_stop', 'callback', 'membership']);
const ACCESS_AUTHORIZATIONS = new Set(['authorized', 'whoami', 'denied', 'ignored']);
const ACCESS_TRIGGERS = new Set(['command', 'mention', 'reply', 'none']);
const ACCESS_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const NATIVE_PROMISE_THEN = Promise.prototype.then;

class DispatcherError extends Error {
  constructor(code) {
    super(DISPATCH_ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'DispatcherError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, DispatcherError);
  }
}

function fail(code) {
  throw new DispatcherError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ensureSynchronous(value, code) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (isPromise(value)) {
    try {
      Reflect.apply(NATIVE_PROMISE_THEN, value, [undefined, () => undefined]);
    } catch {
      // Internal-slot detection succeeded; rejection remains a stable contract error.
    }
    fail(code);
  }
  let then;
  try {
    then = value.then;
  } catch {
    fail(code);
  }
  if (typeof then === 'function') {
    fail(code);
  }
  return value;
}

function safeRead(record, key, code = 'DISPATCH_INVALID_UPDATE') {
  if (!isRecord(record)) fail(code);
  try {
    return record[key];
  } catch {
    fail(code);
  }
}

function frozen(value) {
  return Object.freeze(value);
}

function snapshotFunction(record, key, required = true) {
  let value;
  try {
    value = record[key];
  } catch {
    fail('DISPATCH_CONFIG_INVALID');
  }
  if (value === undefined && !required) return null;
  if (typeof value !== 'function') fail('DISPATCH_CONFIG_INVALID');
  return value.bind(record);
}

function snapshotDependencies(options) {
  if (!isRecord(options)) fail('DISPATCH_CONFIG_INVALID');
  let accessPolicy;
  let sessionStore;
  let scopeQueue;
  let updateLedger;
  let allowedAgents;
  let defaultAgent;
  let capabilities;
  let createRequestId;
  let createMessageId;
  try {
    accessPolicy = options.accessPolicy;
    sessionStore = options.sessionStore;
    scopeQueue = options.scopeQueue;
    updateLedger = options.updateLedger;
    allowedAgents = options.allowedAgents;
    defaultAgent = options.defaultAgent;
    capabilities = options.capabilities;
    createRequestId = options.createRequestId;
    createMessageId = options.createMessageId;
  } catch {
    fail('DISPATCH_CONFIG_INVALID');
  }
  if (
    !isRecord(accessPolicy)
    || !isRecord(sessionStore)
    || !isRecord(scopeQueue)
    || !isRecord(updateLedger)
    || !isRecord(capabilities)
    || !Array.isArray(allowedAgents)
    || typeof defaultAgent !== 'string'
    || typeof createRequestId !== 'function'
    || typeof createMessageId !== 'function'
  ) {
    fail('DISPATCH_CONFIG_INVALID');
  }
  let safeAgents;
  try {
    safeAgents = allowedAgents.map((agent) => {
      if (typeof agent !== 'string' || !AGENT_PATTERN.test(agent)) fail('DISPATCH_CONFIG_INVALID');
      return agent;
    });
  } catch (error) {
    if (error instanceof DispatcherError) throw error;
    fail('DISPATCH_CONFIG_INVALID');
  }
  if (safeAgents.length === 0 || new Set(safeAgents).size !== safeAgents.length) {
    fail('DISPATCH_CONFIG_INVALID');
  }
  if (!safeAgents.includes(defaultAgent)) fail('DISPATCH_CONFIG_INVALID');

  return frozen({
    evaluateAccess: snapshotFunction(accessPolicy, 'evaluate'),
    getOrCreateScope: snapshotFunction(sessionStore, 'getOrCreateScope'),
    getActiveScope: snapshotFunction(sessionStore, 'getActiveScope'),
    switchAgent: snapshotFunction(sessionStore, 'switchAgent'),
    startNewConversation: snapshotFunction(sessionStore, 'startNewConversation'),
    enqueue: snapshotFunction(scopeQueue, 'enqueue'),
    rejectUpdate: snapshotFunction(updateLedger, 'rejectUpdate'),
    authorizeAndQueue: snapshotFunction(updateLedger, 'authorizeAndQueue'),
    getRequest: snapshotFunction(updateLedger, 'getRequest'),
    claimRequest: snapshotFunction(updateLedger, 'claimRequest'),
    markEffectStarted: snapshotFunction(updateLedger, 'markEffectStarted'),
    markEffectUnknown: snapshotFunction(updateLedger, 'markEffectUnknown'),
    completeRequest: snapshotFunction(updateLedger, 'completeRequest'),
    failBeforeEffect: snapshotFunction(updateLedger, 'failBeforeEffect'),
    markNeedsReview: snapshotFunction(updateLedger, 'markNeedsReview'),
    respond: snapshotFunction(capabilities, 'respond'),
    prepareAttachments: snapshotFunction(capabilities, 'prepareAttachments'),
    conversation: snapshotFunction(capabilities, 'conversation'),
    getActiveStopBinding: snapshotFunction(capabilities, 'getActiveStopBinding'),
    stop: snapshotFunction(capabilities, 'stop'),
    retry: snapshotFunction(capabilities, 'retry'),
    retryCandidates: snapshotFunction(capabilities, 'retryCandidates', false),
    tasks: snapshotFunction(capabilities, 'tasks'),
    status: snapshotFunction(capabilities, 'status'),
    allowedAgents: frozen([...safeAgents]),
    defaultAgent,
    createRequestId,
    createMessageId,
  });
}

function validateGeneratedId(value) {
  const synchronous = ensureSynchronous(value, 'DISPATCH_ID_INVALID');
  if (typeof synchronous !== 'string' || !REQUEST_ID_PATTERN.test(synchronous)) {
    fail('DISPATCH_ID_INVALID');
  }
  return synchronous;
}

function parseCommandText(text, commandTriggered) {
  if (!commandTriggered) return null;
  const match = COMMAND_PATTERN.exec(text);
  if (!match) fail('DISPATCH_INVALID_UPDATE');
  return frozen({ name: match[1].toLowerCase(), argument: (match[3] ?? '').trim() });
}

function snapshotAccessDecision(value) {
  const synchronous = ensureSynchronous(value, 'DISPATCH_INVALID_UPDATE');
  if (!isRecord(synchronous)) fail('DISPATCH_INVALID_UPDATE');
  let authorization;
  let kind;
  let reason;
  let chatId;
  let threadId;
  let userId;
  let trigger;
  let draftId;
  try {
    authorization = synchronous.authorization;
    kind = synchronous.kind;
    reason = synchronous.reason;
    chatId = synchronous.chatId;
    threadId = synchronous.threadId;
    userId = synchronous.userId;
    trigger = synchronous.trigger;
    draftId = synchronous.draftId;
  } catch {
    fail('DISPATCH_INVALID_UPDATE');
  }
  if (
    !ACCESS_AUTHORIZATIONS.has(authorization)
    || !ACCESS_KINDS.has(kind)
    || typeof reason !== 'string'
    || !ACCESS_REASON_PATTERN.test(reason)
  ) {
    fail('DISPATCH_INVALID_UPDATE');
  }
  let normalizedChatId;
  let normalizedThreadId;
  let normalizedUserId;
  let normalizedDraftId;
  try {
    normalizedChatId = chatId === undefined
      ? undefined
      : normalizeTelegramId(chatId, { signed: true });
    normalizedThreadId = threadId === undefined
      ? undefined
      : normalizeTelegramId(threadId, { signed: false, allowZero: true });
    normalizedUserId = userId === undefined
      ? undefined
      : normalizeTelegramId(userId, { signed: false });
    normalizedDraftId = draftId === undefined
      ? undefined
      : normalizeTelegramId(draftId, { signed: false });
  } catch {
    fail('DISPATCH_INVALID_UPDATE');
  }

  if (kind === 'message') {
    if (
      normalizedChatId === undefined
      || normalizedThreadId === undefined
      || normalizedUserId === undefined
      || !ACCESS_TRIGGERS.has(trigger)
      || normalizedDraftId !== undefined
      || !['authorized', 'whoami', 'denied'].includes(authorization)
    ) {
      fail('DISPATCH_INVALID_UPDATE');
    }
  } else if (kind === 'native_stop') {
    if (trigger !== undefined) fail('DISPATCH_INVALID_UPDATE');
    if (!['authorized', 'denied'].includes(authorization)) fail('DISPATCH_INVALID_UPDATE');
    if (authorization === 'authorized' && (
      normalizedChatId === undefined
      || normalizedThreadId === undefined
      || normalizedUserId === undefined
      || normalizedDraftId === undefined
    )) {
      fail('DISPATCH_INVALID_UPDATE');
    }
  } else if (kind === 'callback') {
    if (
      authorization !== 'denied'
      || trigger !== undefined
      || normalizedDraftId !== undefined
    ) {
      fail('DISPATCH_INVALID_UPDATE');
    }
  } else if (kind === 'membership') {
    if (
      authorization !== 'ignored'
      || trigger !== undefined
      || normalizedDraftId !== undefined
    ) {
      fail('DISPATCH_INVALID_UPDATE');
    }
  }

  return frozen({
    authorization,
    kind,
    reason,
    ...(normalizedChatId === undefined ? {} : { chatId: normalizedChatId }),
    ...(normalizedThreadId === undefined ? {} : { threadId: normalizedThreadId }),
    ...(normalizedUserId === undefined ? {} : { userId: normalizedUserId }),
    ...(trigger === undefined ? {} : { trigger }),
    ...(normalizedDraftId === undefined ? {} : { draftId: normalizedDraftId }),
  });
}

function snapshotAuthorizedMessage(update, decision) {
  const message = safeRead(update, 'message');
  const text = safeRead(message, 'text');
  const caption = safeRead(message, 'caption');
  const telegramMessageId = normalizeTelegramId(safeRead(message, 'message_id'), { signed: false });
  if (text !== undefined && caption !== undefined) fail('DISPATCH_INVALID_UPDATE');
  if (text !== undefined && typeof text !== 'string') fail('DISPATCH_INVALID_UPDATE');
  if (caption !== undefined && typeof caption !== 'string') fail('DISPATCH_INVALID_UPDATE');
  const safeText = text ?? caption ?? '';
  if (Buffer.byteLength(safeText, 'utf8') > 1_048_576) fail('DISPATCH_INVALID_UPDATE');
  let telegramMessage;
  try {
    telegramMessage = JSON.parse(JSON.stringify(message));
  } catch {
    fail('DISPATCH_INVALID_UPDATE');
  }
  return frozen({
    text: safeText,
    telegramMessageId,
    telegramMessage: frozen(telegramMessage),
    command: parseCommandText(safeText, decision.trigger === 'command'),
  });
}

function snapshotScope(value, chatId, threadId) {
  const synchronous = ensureSynchronous(value, 'DISPATCH_SESSION_FAILED');
  if (!isRecord(synchronous)) fail('DISPATCH_SESSION_FAILED');
  let key;
  let scopeChatId;
  let scopeThreadId;
  let currentAgent;
  let conversationId;
  let isActive;
  try {
    key = synchronous.key;
    scopeChatId = synchronous.chatId;
    scopeThreadId = synchronous.threadId;
    currentAgent = synchronous.currentAgent;
    conversationId = synchronous.conversationId;
    isActive = synchronous.isActive;
  } catch {
    fail('DISPATCH_SESSION_FAILED');
  }
  if (
    typeof currentAgent !== 'string' || !AGENT_PATTERN.test(currentAgent)
    || scopeChatId !== chatId || scopeThreadId !== threadId
    || key !== `telegram:${chatId}:${threadId}:${currentAgent}`
    || typeof conversationId !== 'string'
    || typeof isActive !== 'boolean'
  ) {
    fail('DISPATCH_SESSION_FAILED');
  }
  return frozen({
    key,
    chatId: scopeChatId,
    threadId: scopeThreadId,
    currentAgent,
    conversationId,
    isActive,
  });
}

function isOwnedRetryCandidate(value, context) {
  const synchronous = ensureSynchronous(value, 'DISPATCH_RETRY_FAILED');
  if (!isRecord(synchronous)) return false;
  let ownerUserId;
  let scopeKey;
  let status;
  let replayPolicy;
  try {
    ownerUserId = synchronous.ownerUserId;
    scopeKey = synchronous.scopeKey;
    status = synchronous.status;
    replayPolicy = synchronous.replayPolicy;
  } catch {
    fail('DISPATCH_RETRY_FAILED');
  }
  return (
    ownerUserId === context.ownerUserId
    && scopeKey === context.scope.key
    && RETRYABLE_REQUEST_STATUSES.has(status)
    && SUPPORTED_REPLAY_POLICIES.has(replayPolicy)
  );
}

function failClaimedBeforeEffect(deps, requestId, errorCode) {
  try {
    const failed = ensureSynchronous(
      deps.failBeforeEffect(requestId, errorCode),
      'DISPATCH_LEDGER_FAILED',
    );
    if (safeRead(failed, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
      fail('DISPATCH_LEDGER_FAILED');
    }
  } catch (error) {
    if (error instanceof DispatcherError) throw error;
    fail('DISPATCH_LEDGER_FAILED');
  }
}

function readCommittedScope(deps, context, allowUnlistedAgent = false) {
  let active;
  try {
    active = snapshotScope(
      deps.getActiveScope({ chatId: context.chatId, threadId: context.threadId }),
      context.chatId,
      context.threadId,
    );
  } catch {
    return null;
  }
  if (
    active.isActive !== true
    || active.key !== context.scope.key
    || active.currentAgent !== context.scope.currentAgent
    || (!allowUnlistedAgent && !deps.allowedAgents.includes(active.currentAgent))
  ) {
    return null;
  }
  return active;
}

function safeReject(deps, updateId, errorCode) {
  try {
    return ensureSynchronous(
      deps.rejectUpdate(updateId, errorCode),
      'DISPATCH_LEDGER_FAILED',
    );
  } catch {
    fail('DISPATCH_LEDGER_FAILED');
  }
}

function consumeImmediateUpdate(deps, updateId, errorCode) {
  const consumed = safeReject(deps, updateId, errorCode);
  return safeRead(consumed, 'changed', 'DISPATCH_LEDGER_FAILED') === true;
}

async function safeRespond(deps, payload) {
  try {
    return await deps.respond(frozen(payload));
  } catch {
    fail('DISPATCH_RESPONSE_FAILED');
  }
}

function snapshotStatus(value) {
  if (!isRecord(value)) {
    return frozen({
      mode: 'unknown',
      state: 'unknown',
      vcpReadiness: 'unknown',
      pollerState: 'unknown',
      activeRequests: 0,
      queuedRequests: 0,
      deadLetters: 0,
    });
  }
  let mode;
  let state;
  let vcpReadiness;
  let pollerState;
  let activeRequests;
  let queuedRequests;
  let deadLetters;
  try {
    mode = value.mode;
    state = value.state;
    vcpReadiness = value.vcpReadiness;
    pollerState = value.pollerState;
    activeRequests = value.activeRequests;
    queuedRequests = value.queuedRequests;
    deadLetters = value.deadLetters;
  } catch {
    return frozen({
      mode: 'unknown',
      state: 'unknown',
      vcpReadiness: 'unknown',
      pollerState: 'unknown',
      activeRequests: 0,
      queuedRequests: 0,
      deadLetters: 0,
    });
  }
  const safeStatus = (candidate) => (
    typeof candidate === 'string' && TASK_STATUS_PATTERN.test(candidate)
      ? candidate
      : 'unknown'
  );
  const safeCount = (candidate) => (
    Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 10000
      ? candidate
      : 0
  );
  return frozen({
    mode: safeStatus(mode),
    state: safeStatus(state),
    vcpReadiness: safeStatus(vcpReadiness),
    pollerState: safeStatus(pollerState),
    activeRequests: safeCount(activeRequests),
    queuedRequests: safeCount(queuedRequests),
    deadLetters: safeCount(deadLetters),
  });
}

function snapshotTasks(value) {
  if (!Array.isArray(value)) return frozen([]);
  const safe = [];
  for (const task of value.slice(0, 50)) {
    if (!isRecord(task)) continue;
    let taskId;
    let status;
    try {
      taskId = task.taskId;
      status = task.status;
    } catch {
      continue;
    }
    if (
      typeof taskId === 'string' && REQUEST_ID_PATTERN.test(taskId)
      && typeof status === 'string' && TASK_STATUS_PATTERN.test(status)
    ) {
      safe.push(frozen({ taskId, status }));
    }
  }
  return frozen(safe);
}

function snapshotStopBinding(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) fail('DISPATCH_STOP_FAILED');
  let requestId;
  let ownerUserId;
  let chatId;
  let threadId;
  let draftId;
  try {
    requestId = value.requestId;
    ownerUserId = value.ownerUserId;
    chatId = value.chatId;
    threadId = value.threadId;
    draftId = value.draftId;
  } catch {
    fail('DISPATCH_STOP_FAILED');
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    fail('DISPATCH_STOP_FAILED');
  }
  try {
    return frozen({
      requestId,
      ownerUserId: normalizeTelegramId(ownerUserId, { signed: false }),
      chatId: normalizeTelegramId(chatId, { signed: true }),
      threadId: normalizeTelegramId(threadId, { signed: false, allowZero: true }),
      draftId: draftId === null || draftId === undefined
        ? null
        : normalizeTelegramId(draftId, { signed: false }),
    });
  } catch {
    fail('DISPATCH_STOP_FAILED');
  }
}

function snapshotStopOutcome(value, expectedRequestId) {
  if (!isPlainRecord(value)) fail('DISPATCH_STOP_FAILED');
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    fail('DISPATCH_STOP_FAILED');
  }
  if (
    keys.length !== 2
    || !keys.includes('stopped')
    || !keys.includes('requestId')
  ) {
    fail('DISPATCH_STOP_FAILED');
  }
  const stoppedDescriptor = descriptors.stopped;
  const requestIdDescriptor = descriptors.requestId;
  if (
    !isRecord(stoppedDescriptor)
    || !isRecord(requestIdDescriptor)
    || stoppedDescriptor.enumerable !== true
    || requestIdDescriptor.enumerable !== true
    || !Object.hasOwn(stoppedDescriptor, 'value')
    || !Object.hasOwn(requestIdDescriptor, 'value')
    || Object.hasOwn(stoppedDescriptor, 'get')
    || Object.hasOwn(stoppedDescriptor, 'set')
    || Object.hasOwn(requestIdDescriptor, 'get')
    || Object.hasOwn(requestIdDescriptor, 'set')
  ) {
    fail('DISPATCH_STOP_FAILED');
  }
  const stopped = stoppedDescriptor.value;
  const requestId = requestIdDescriptor.value;
  if (typeof stopped !== 'boolean' || typeof requestId !== 'string') {
    fail('DISPATCH_STOP_FAILED');
  }
  return frozen({
    exact: stopped === true && requestId === expectedRequestId,
  });
}

function snapshotConversationOutcome(value) {
  if (!isPlainRecord(value)) fail('DISPATCH_CONVERSATION_FAILED');
  let accepted;
  let completionPersisted;
  try {
    accepted = value.accepted;
    completionPersisted = value.completionPersisted ?? false;
  } catch {
    fail('DISPATCH_CONVERSATION_FAILED');
  }
  if (accepted !== true || typeof completionPersisted !== 'boolean') fail('DISPATCH_CONVERSATION_FAILED');
  return frozen({ accepted: true, completionPersisted });
}

function quarantineStartedEffect(deps, requestId) {
  try {
    ensureSynchronous(
      deps.markEffectUnknown(requestId),
      'DISPATCH_LEDGER_FAILED',
    );
  } catch {
    // Continue to the terminal needs-review CAS even if the intermediate CAS raced.
  }
  try {
    ensureSynchronous(
      deps.markNeedsReview(requestId, 'DISPATCH_EFFECT_UNKNOWN'),
      'DISPATCH_LEDGER_FAILED',
    );
  } catch {
    // Restart recovery remains conservative for any still-started request.
  }
}

function startClaimedEffect(deps, requestId) {
  try {
    const transition = ensureSynchronous(
      deps.markEffectStarted(requestId),
      'DISPATCH_LEDGER_FAILED',
    );
    if (safeRead(transition, 'changed', 'DISPATCH_LEDGER_FAILED') === true) return;
  } catch {
    // No external effect has started, so a retryable terminal state is still safe.
  }
  failClaimedBeforeEffect(deps, requestId, 'DISPATCH_EFFECT_NOT_STARTED');
  fail('DISPATCH_LEDGER_FAILED');
}

function bindingMatches(binding, decision, requireDraft) {
  return Boolean(
    binding
    && binding.ownerUserId === decision.userId
    && binding.chatId === decision.chatId
    && binding.threadId === decision.threadId
    && (!requireDraft || binding.draftId === decision.draftId)
  );
}

async function handleStop(deps, updateId, decision, source) {
  const consumed = safeReject(deps, updateId, 'CONTROL_CONSUMED');
  if (safeRead(consumed, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
    return frozen({ status: 'duplicate', code: 'CONTROL_DUPLICATE' });
  }

  let binding;
  try {
    binding = snapshotStopBinding(await deps.getActiveStopBinding(frozen({
      ownerUserId: decision.userId,
      chatId: decision.chatId,
      threadId: decision.threadId,
      ...(source === 'native' ? { draftId: decision.draftId } : {}),
    })));
  } catch (error) {
    if (error instanceof DispatcherError) throw error;
    fail('DISPATCH_STOP_FAILED');
  }
  const requireDraft = source === 'native';
  if (!bindingMatches(binding, decision, requireDraft)) {
    if (source === 'command') {
      await safeRespond(deps, {
        type: 'no_active_request', chatId: decision.chatId, threadId: decision.threadId,
      });
    }
    return frozen({ status: 'handled', code: 'NO_ACTIVE_REQUEST' });
  }
  let outcome;
  try {
    outcome = snapshotStopOutcome(await deps.stop(frozen({
      requestId: binding.requestId,
      ownerUserId: binding.ownerUserId,
      chatId: binding.chatId,
      threadId: binding.threadId,
      draftId: binding.draftId,
      source,
    })), binding.requestId);
  } catch (error) {
    if (error instanceof DispatcherError) throw error;
    fail('DISPATCH_STOP_FAILED');
  }
  if (!outcome.exact) {
    if (source === 'command') {
      await safeRespond(deps, {
        type: 'no_active_request', chatId: decision.chatId, threadId: decision.threadId,
      });
    }
    return frozen({ status: 'handled', code: 'CONTROL_RACE' });
  }
  if (source === 'command') {
    await safeRespond(deps, {
      type: 'stop_result', chatId: decision.chatId, threadId: decision.threadId, stopped: true,
    });
  }
  return frozen({ status: 'handled', code: 'STOPPED' });
}

async function executeCommand(deps, context, command) {
  const base = {
    chatId: context.chatId,
    threadId: context.threadId,
  };
  if (command.name === 'start' || command.name === 'help') {
    await safeRespond(deps, { type: command.name, ...base });
    return frozen({ type: command.name });
  }
  if (command.name === 'agent') {
    if (command.argument === '') {
      await safeRespond(deps, {
        type: 'agent_list', ...base,
        activeAgent: deps.allowedAgents.includes(context.scope.currentAgent)
          ? context.scope.currentAgent
          : null,
        allowedAgents: deps.allowedAgents,
      });
      return frozen({ type: 'agent_list' });
    }
    if (!deps.allowedAgents.includes(command.argument)) {
      await safeRespond(deps, { type: 'agent_not_allowed', ...base });
      return frozen({ type: 'agent_not_allowed' });
    }
    let switched;
    try {
      switched = snapshotScope(
        deps.switchAgent(context.scope.key, command.argument),
        context.chatId,
        context.threadId,
      );
      if (switched.currentAgent !== command.argument || switched.isActive !== true) {
        fail('DISPATCH_SESSION_FAILED');
      }
    } catch {
      fail('DISPATCH_SESSION_FAILED');
    }
    await safeRespond(deps, {
      type: 'agent_switched', ...base, agent: switched.currentAgent,
    });
    return frozen({ type: 'agent_switched' });
  }
  if (command.name === 'new') {
    if (command.argument !== '') {
      await safeRespond(deps, { type: 'command_invalid', ...base });
      return frozen({ type: 'command_invalid' });
    }
    let next;
    try {
      next = snapshotScope(
        deps.startNewConversation(context.scope.key),
        context.chatId,
        context.threadId,
      );
      if (next.currentAgent !== context.scope.currentAgent || next.isActive !== true) {
        fail('DISPATCH_SESSION_FAILED');
      }
    } catch {
      fail('DISPATCH_SESSION_FAILED');
    }
    await safeRespond(deps, {
      type: 'new_conversation', ...base, agent: next.currentAgent,
    });
    return frozen({ type: 'new_conversation' });
  }
  if (command.name === 'status') {
    if (command.argument !== '') {
      await safeRespond(deps, { type: 'command_invalid', ...base });
      return frozen({ type: 'command_invalid' });
    }
    let status;
    try {
      status = snapshotStatus(await deps.status(frozen({
        ownerUserId: context.ownerUserId, ...base,
        scopeKey: context.scope.key, agent: context.scope.currentAgent,
      })));
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_STATUS_FAILED');
    }
    await safeRespond(deps, {
      type: 'status', ...base, agent: context.scope.currentAgent,
      mode: status.mode,
      state: status.state,
      vcpReadiness: status.vcpReadiness,
      pollerState: status.pollerState,
      activeRequests: status.activeRequests,
      queuedRequests: status.queuedRequests,
      deadLetters: status.deadLetters,
    });
    return frozen({ type: 'status' });
  }
  if (command.name === 'tasks') {
    if (command.argument !== '') {
      await safeRespond(deps, { type: 'command_invalid', ...base });
      return frozen({ type: 'command_invalid' });
    }
    let tasks;
    try {
      tasks = snapshotTasks(await deps.tasks(frozen({
        ownerUserId: context.ownerUserId, ...base, scopeKey: context.scope.key,
      })));
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_TASKS_FAILED');
    }
    await safeRespond(deps, { type: 'tasks', ...base, tasks });
    return frozen({ type: 'tasks' });
  }
  if (command.name === 'retry') {
    if (command.argument === '' && deps.retryCandidates) {
      const rows=await deps.retryCandidates(frozen({ownerUserId:context.ownerUserId,scopeKey:context.scope.key}));
      const requests=Array.isArray(rows) ? rows.slice(0,10).filter(row=>isRecord(row)
        && typeof row.requestId==='string' && REQUEST_ID_PATTERN.test(row.requestId)
        && RETRYABLE_REQUEST_STATUSES.has(row.status)).map(row=>frozen({requestId:row.requestId,status:row.status})) : [];
      await safeRespond(deps,{type:'retry_options',...base,requests});
      return frozen({type:'retry_options'});
    }
    if (!REQUEST_ID_PATTERN.test(command.argument)) {
      await safeRespond(deps, { type: 'retry_invalid', ...base });
      return frozen({ type: 'retry_invalid' });
    }
    let target;
    try {
      target = deps.getRequest(command.argument);
    } catch {
      fail('DISPATCH_RETRY_FAILED');
    }
    if (!isOwnedRetryCandidate(target, context)) {
      await safeRespond(deps, { type: 'retry_refused', ...base });
      return frozen({ type: 'retry_refused' });
    }
    let outcome;
    try {
      outcome = await deps.retry(frozen({
        ownerUserId: context.ownerUserId,
        ...base,
        scopeKey: context.scope.key,
        targetRequestId: command.argument,
      }));
    } catch {
      fail('DISPATCH_RETRY_FAILED');
    }
    const accepted = isRecord(outcome) && safeRead(outcome, 'accepted', 'DISPATCH_RETRY_FAILED') === true;
    await safeRespond(deps, { type: accepted ? 'retry_accepted' : 'retry_refused', ...base });
    return frozen({ type: accepted ? 'retry_accepted' : 'retry_refused' });
  }
  if (command.name === 'stop' || command.name === 'whoami') {
    await safeRespond(deps, { type: 'command_invalid', ...base });
    return frozen({ type: 'command_invalid' });
  }
  await safeRespond(deps, { type: 'unknown_command', ...base });
  return frozen({ type: 'unknown_command' });
}

async function executeQueued(deps, context, message) {
  let claimed;
  try {
    claimed = ensureSynchronous(
      deps.claimRequest(context.requestId, 'telegram-dispatcher'),
      'DISPATCH_LEDGER_FAILED',
    );
  } catch {
    fail('DISPATCH_LEDGER_FAILED');
  }
  if (!isRecord(claimed) || claimed.changed !== true) {
    return frozen({ type: 'duplicate' });
  }

  const committedScope = readCommittedScope(
    deps,
    context,
    message.command?.name === 'agent',
  );
  if (committedScope === null) {
    failClaimedBeforeEffect(deps, context.requestId, 'AGENT_ROUTE_NOT_COMMITTED');
    return frozen({ type: 'agent_route_not_committed' });
  }

  const execution = frozen({ ...context, scope: committedScope });
  if (!message.command) {
    let attachments;
    try {
      attachments = await deps.prepareAttachments(frozen({
        updateId: context.updateId,
        ownerUserId: context.ownerUserId,
        chatId: context.chatId,
        threadId: context.threadId,
        telegramMessageId: message.telegramMessageId,
        message: message.telegramMessage,
        scopeKey: committedScope.key,
        requestId: context.requestId,
      }));
    } catch {
      failClaimedBeforeEffect(deps, context.requestId, 'DISPATCH_ATTACHMENT_FAILED');
      fail('DISPATCH_ATTACHMENT_FAILED');
    }
    if (!Array.isArray(attachments)) {
      failClaimedBeforeEffect(deps, context.requestId, 'DISPATCH_ATTACHMENT_FAILED');
      fail('DISPATCH_ATTACHMENT_FAILED');
    }

    let effectStarted = false;
    try {
      startClaimedEffect(deps, context.requestId);
      effectStarted = true;
      const outcome = snapshotConversationOutcome(await deps.conversation(frozen({
        requestId: context.requestId,
        messageId: context.messageId,
        ownerUserId: context.ownerUserId,
        chatId: context.chatId,
        threadId: context.threadId,
        scope: committedScope,
        text: message.text,
        telegramMessageId: message.telegramMessageId,
        attachments: frozen([...attachments]),
      })));
      if (outcome.completionPersisted) {
        const persisted = ensureSynchronous(
          deps.getRequest(context.requestId),
          'DISPATCH_LEDGER_FAILED',
        );
        if (persisted?.status !== 'completed' || persisted?.effectState !== 'confirmed') {
          fail('DISPATCH_LEDGER_FAILED');
        }
        return frozen({ type: 'conversation_completed' });
      }
      const completed = ensureSynchronous(
        deps.completeRequest(context.requestId),
        'DISPATCH_LEDGER_FAILED',
      );
      if (safeRead(completed, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
        fail('DISPATCH_LEDGER_FAILED');
      }
      return frozen({ type: 'conversation_completed' });
    } catch (error) {
      if (effectStarted) quarantineStartedEffect(deps, context.requestId);
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_CONVERSATION_FAILED');
    }
  }

  let effectStarted = false;
  try {
    startClaimedEffect(deps, context.requestId);
    effectStarted = true;
    const result = await executeCommand(deps, execution, message.command);

    const completed = ensureSynchronous(
      deps.completeRequest(context.requestId),
      'DISPATCH_LEDGER_FAILED',
    );
    if (!isRecord(completed) || completed.changed !== true) fail('DISPATCH_LEDGER_FAILED');
    return result;
  } catch (error) {
    if (effectStarted) {
      quarantineStartedEffect(deps, context.requestId);
    }
    if (error instanceof DispatcherError) throw error;
    fail('DISPATCH_EXECUTION_FAILED');
  }
}

function createUpdateDispatcher(options = {}) {
  const deps = snapshotDependencies(options);
  const plannedAgents = new Map();
  let nextProjectionToken = 0;

  function clearProjection(orderingKey, token) {
    const current = plannedAgents.get(orderingKey);
    if (current?.token === token) plannedAgents.delete(orderingKey);
  }

  async function dispatchInternal(input = {}, idOverrides = null) {
    let updateId;
    let update;
    try {
      updateId = normalizeTelegramId(safeRead(input, 'updateId'), { signed: false });
      update = safeRead(input, 'update');
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_INVALID_UPDATE');
    }

    let decision;
    try {
      decision = snapshotAccessDecision(deps.evaluateAccess(update));
    } catch (error) {
      if (error instanceof AccessPolicyError && error.code === 'ACCESS_UNSUPPORTED_UPDATE') {
        fail('DISPATCH_UNSUPPORTED_UPDATE');
      }
      fail('DISPATCH_INVALID_UPDATE');
    }

    if (decision.authorization === 'ignored') {
      if (!consumeImmediateUpdate(deps, updateId, decision.reason)) {
        return frozen({ status: 'duplicate', code: 'DUPLICATE' });
      }
      return frozen({ status: 'ignored', code: decision.reason });
    }
    if (decision.authorization === 'denied') {
      const code = decision.kind === 'callback' ? decision.reason : 'ACCESS_DENIED';
      if (!consumeImmediateUpdate(deps, updateId, code)) {
        return frozen({ status: 'duplicate', code: 'DUPLICATE' });
      }
      if (decision.kind === 'message' && decision.chatId && !decision.chatId.startsWith('-')) {
        await safeRespond(deps, {
          type: 'access_denied', chatId: decision.chatId, threadId: decision.threadId,
        });
      }
      return frozen({ status: 'rejected', code });
    }
    if (decision.authorization === 'whoami') {
      if (!consumeImmediateUpdate(deps, updateId, 'WHOAMI_HANDLED')) {
        return frozen({ status: 'duplicate', code: 'DUPLICATE' });
      }
      await safeRespond(deps, {
        type: 'whoami', chatId: decision.chatId,
        threadId: decision.threadId, userId: decision.userId,
      });
      return frozen({ status: 'handled', code: 'WHOAMI' });
    }
    if (decision.kind === 'native_stop') {
      return handleStop(deps, updateId, decision, 'native');
    }
    if (decision.kind !== 'message' || decision.authorization !== 'authorized') {
      fail('DISPATCH_INVALID_UPDATE');
    }

    const message = snapshotAuthorizedMessage(update, decision);
    if (message.command?.name === 'whoami' && message.command.argument === '') {
      if (!consumeImmediateUpdate(deps, updateId, 'WHOAMI_HANDLED')) {
        return frozen({ status: 'duplicate', code: 'DUPLICATE' });
      }
      await safeRespond(deps, {
        type: 'whoami', chatId: decision.chatId,
        threadId: decision.threadId, userId: decision.userId,
      });
      return frozen({ status: 'handled', code: 'WHOAMI' });
    }
    if (message.command?.name === 'stop' && message.command.argument === '') {
      return handleStop(deps, updateId, decision, 'command');
    }

    const orderingKey = orderingKeyFor(decision.chatId, decision.threadId);
    let requestId;
    let messageId;
    try {
      requestId = idOverrides === null
        ? validateGeneratedId(deps.createRequestId(frozen({ updateId })))
        : validateGeneratedId(idOverrides.requestId);
      messageId = idOverrides === null
        ? validateGeneratedId(deps.createMessageId(frozen({
            updateId, telegramMessageId: message.telegramMessageId,
          })))
        : validateGeneratedId(idOverrides.messageId);
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_ID_INVALID');
    }
    let scope;
    try {
      const plannedAgent = plannedAgents.get(orderingKey)?.agent;
      const rawScope = deps.getOrCreateScope({
        chatId: decision.chatId,
        threadId: decision.threadId,
        ...(plannedAgent === undefined ? {} : { agent: plannedAgent }),
      });
      scope = snapshotScope(rawScope, decision.chatId, decision.threadId);
      if (plannedAgent !== undefined && scope.currentAgent !== plannedAgent) {
        fail('DISPATCH_SESSION_FAILED');
      }
    } catch (error) {
      if (error instanceof DispatcherError) throw error;
      fail('DISPATCH_SESSION_FAILED');
    }

    let authorized;
    try {
      authorized = ensureSynchronous(
        deps.authorizeAndQueue(updateId, {
          requestId,
          messageId,
          scopeKey: scope.key,
          orderingKey,
          ownerUserId: decision.userId,
          replayPolicy: 'manual',
        }),
        'DISPATCH_LEDGER_FAILED',
      );
    } catch {
      fail('DISPATCH_LEDGER_FAILED');
    }
    if (safeRead(authorized, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
      let existing;
      try {
        existing = ensureSynchronous(deps.getRequest(requestId), 'DISPATCH_LEDGER_FAILED');
      } catch {
        fail('DISPATCH_LEDGER_FAILED');
      }
      if (
        existing?.status !== 'queued'
        || existing?.effectState !== 'not_started'
        || existing?.ownerUserId !== decision.userId
        || existing?.orderingKey !== orderingKey
        || existing?.messageId !== messageId
        || typeof existing?.scopeKey !== 'string'
      ) {
        return frozen({ status: 'duplicate', code: 'DUPLICATE', requestId, orderingKey });
      }
      if (existing.scopeKey !== scope.key) {
        const agent = existing.scopeKey.slice(existing.scopeKey.lastIndexOf(':') + 1);
        try {
          scope = snapshotScope(deps.getOrCreateScope({
            chatId: decision.chatId,
            threadId: decision.threadId,
            agent,
          }), decision.chatId, decision.threadId);
        } catch {
          fail('DISPATCH_SESSION_FAILED');
        }
        if (scope.key !== existing.scopeKey) fail('DISPATCH_SESSION_FAILED');
      }
    }

    let projectionToken = null;
    if (
      message.command?.name === 'agent'
      && deps.allowedAgents.includes(message.command.argument)
    ) {
      projectionToken = ++nextProjectionToken;
      plannedAgents.set(orderingKey, frozen({
        agent: message.command.argument,
        token: projectionToken,
      }));
    }

    if (!deps.allowedAgents.includes(scope.currentAgent) && message.command?.name !== 'agent') {
      try {
        const claimed = ensureSynchronous(
          deps.claimRequest(requestId, 'telegram-dispatcher'),
          'DISPATCH_LEDGER_FAILED',
        );
        if (safeRead(claimed, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
          return frozen({ status: 'duplicate', code: 'DUPLICATE', requestId, orderingKey });
        }
        const failed = ensureSynchronous(
          deps.failBeforeEffect(requestId, 'AGENT_NOT_ALLOWED'),
          'DISPATCH_LEDGER_FAILED',
        );
        if (safeRead(failed, 'changed', 'DISPATCH_LEDGER_FAILED') !== true) {
          fail('DISPATCH_LEDGER_FAILED');
        }
      } catch (error) {
        if (error instanceof DispatcherError) throw error;
        fail('DISPATCH_LEDGER_FAILED');
      }
      return frozen({ status: 'rejected', code: 'AGENT_NOT_ALLOWED', requestId, orderingKey });
    }

    const context = frozen({
      updateId,
      requestId,
      messageId,
      ownerUserId: decision.userId,
      chatId: decision.chatId,
      threadId: decision.threadId,
      orderingKey,
      scope,
    });
    let admission;
    try {
      admission = ensureSynchronous(
        deps.enqueue({
          requestId,
          orderingKey,
          run: () => executeQueued(deps, context, message),
        }),
        'DISPATCH_QUEUE_FAILED',
      );
    } catch (error) {
      if (projectionToken !== null) clearProjection(orderingKey, projectionToken);
      if (error?.code === 'QUEUE_DUPLICATE') {
        return frozen({ status: 'duplicate', code: 'DUPLICATE', requestId, orderingKey });
      }
      fail('DISPATCH_QUEUE_FAILED');
    }
    let completion;
    try {
      const admissionResult = safeRead(admission, 'result', 'DISPATCH_QUEUE_FAILED');
      const trackedResult = Promise.resolve(admissionResult).then(
        (value) => {
          if (projectionToken !== null) clearProjection(orderingKey, projectionToken);
          return value;
        },
        (error) => {
          if (projectionToken !== null) clearProjection(orderingKey, projectionToken);
          throw error;
        },
      );
      completion = trackedResult.then((value) => {
        let type;
        try {
          type = isRecord(value) ? value.type : undefined;
        } catch {
          fail('DISPATCH_QUEUE_FAILED');
        }
        return frozen({
          status: type === 'agent_route_not_committed' || type === 'duplicate'
            ? 'not_processed'
            : 'processed',
        });
      });
      void completion.catch(() => {});
    } catch {
      if (projectionToken !== null) clearProjection(orderingKey, projectionToken);
      fail('DISPATCH_QUEUE_FAILED');
    }
    return frozen({
      status: 'queued',
      code: 'QUEUED',
      requestId,
      orderingKey,
      completion,
    });
  }

  function dispatch(input = {}) {
    return dispatchInternal(input, null);
  }

  function resume(input = {}) {
    let requestId;
    let messageId;
    let updateId;
    let update;
    try {
      requestId = input.requestId;
      messageId = input.messageId;
      updateId = input.updateId;
      update = input.update;
    } catch {
      const rejected = Promise.reject(new DispatcherError('DISPATCH_INVALID_UPDATE'));
      rejected.catch(() => {});
      return rejected;
    }
    return dispatchInternal({ updateId, update }, { requestId, messageId });
  }

  return frozen({ dispatch, resume });
}

module.exports = {
  DispatcherError,
  createUpdateDispatcher,
};
