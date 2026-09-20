'use strict';

const crypto = require('node:crypto');

const UPDATE_ID_PATTERN = /^[1-9]\d{0,127}$/;
const OFFSET_PATTERN = /^[1-9]\d{0,128}$/;
const UPDATE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MESSAGE_ID_PATTERN = REQUEST_ID_PATTERN;
const WORKER_ID_PATTERN = REQUEST_ID_PATTERN;
const SCOPE_KEY_PATTERN = /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*):[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ORDERING_KEY_PATTERN = /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*)$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const OWNER_USER_ID_PATTERN = /^[1-9]\d{0,127}$/;
const REPLAY_POLICIES = new Set(['safe', 'idempotent', 'manual']);

class UpdateLedgerError extends Error {
  constructor(code) {
    super('Telegram update ledger operation failed.');
    Object.defineProperty(this, 'name', { value: 'UpdateLedgerError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, UpdateLedgerError);
  }
}

function fail(code) {
  throw new UpdateLedgerError(code);
}

function nowFrom(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('LEDGER_CLOCK_INVALID');
  return value;
}

function compareDecimal(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

function maxDecimal(left, right) {
  if (left === null) return right;
  return compareDecimal(left, right) >= 0 ? left : right;
}

function readNextOffset(database) {
  const value = database.prepare(`
    SELECT next_offset FROM updates
    ORDER BY length(next_offset) DESC, next_offset DESC
    LIMIT 1
  `).get()?.next_offset ?? null;
  if (value !== null && (typeof value !== 'string' || !OFFSET_PATTERN.test(value))) {
    fail('OFFSET_INVALID');
  }
  return value;
}

function validateUpdateId(value) {
  if (typeof value !== 'string' || !UPDATE_ID_PATTERN.test(value)) fail('UPDATE_ID_INVALID');
  return value;
}

function validateIdentifier(value, pattern, code = 'LEDGER_INPUT_INVALID') {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function validateErrorCode(value) {
  if (value === null || value === undefined) return null;
  return validateIdentifier(value, ERROR_CODE_PATTERN);
}

function canonicalJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('UPDATE_PAYLOAD_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`
    )).join(',')}}`;
  }
  fail('UPDATE_PAYLOAD_INVALID');
}

function normalizePayload(payload) {
  try {
    const snapshot = JSON.stringify(payload);
    if (typeof snapshot !== 'string') fail('UPDATE_PAYLOAD_INVALID');
    const parsed = JSON.parse(snapshot);
    const payloadJson = canonicalJsonValue(parsed);
    return Object.freeze({
      payloadJson,
      payloadSha256: crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
    });
  } catch (error) {
    if (error instanceof UpdateLedgerError) throw error;
    fail('UPDATE_PAYLOAD_INVALID');
  }
}

function prepareBatch(items) {
  if (!Array.isArray(items)) fail('LEDGER_INPUT_INVALID');
  const unique = new Map();
  let duplicates = 0;
  let maximum = null;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('LEDGER_INPUT_INVALID');
    }
    let rawUpdateId;
    let rawUpdateType;
    let rawPayload;
    let rawRejectErrorCode;
    try {
      rawUpdateId = item.updateId;
      rawUpdateType = item.updateType;
      rawPayload = item.payload;
      rawRejectErrorCode = item.rejectErrorCode;
    } catch {
      fail('LEDGER_INPUT_INVALID');
    }
    const updateId = validateUpdateId(rawUpdateId);
    const updateType = validateIdentifier(rawUpdateType, UPDATE_TYPE_PATTERN);
    const rejectErrorCode = validateErrorCode(rawRejectErrorCode);
    const normalized = normalizePayload(rawPayload);
    const existing = unique.get(updateId);
    if (existing) {
      if (
        existing.payloadSha256 !== normalized.payloadSha256
        || existing.updateType !== updateType
        || existing.rejectErrorCode !== rejectErrorCode
      ) {
        fail('UPDATE_ID_COLLISION');
      }
      duplicates += 1;
      continue;
    }
    unique.set(updateId, Object.freeze({
      updateId,
      updateType,
      rejectErrorCode,
      ...normalized,
    }));
    maximum = maxDecimal(maximum, updateId);
  }
  return Object.freeze({ items: Object.freeze([...unique.values()]), duplicates, maximum });
}

function mapUpdate(row) {
  if (!row) return null;
  return {
    updateId: row.update_id,
    nextOffset: row.next_offset,
    updateType: row.update_type,
    payloadJson: row.payload_json,
    payloadSha256: row.payload_sha256,
    status: row.status,
    scopeKey: row.scope_key,
    orderingKey: row.ordering_key,
    initialRequestId: row.initial_request_id,
    attempt: row.attempt,
    errorCode: row.error_code,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function mapRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    messageId: row.message_id,
    updateId: row.update_id,
    scopeKey: row.scope_key,
    orderingKey: row.ordering_key,
    ownerUserId: row.owner_user_id,
    retryOfRequestId: row.retry_of_request_id,
    status: row.status,
    effectState: row.effect_state,
    replayPolicy: row.replay_policy,
    workerId: row.worker_id,
    attempt: row.attempt,
    errorCode: row.error_code,
    startedAt: row.started_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function createUpdateLedgerForDatabase(database, options = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('LEDGER_CONFIG_INVALID');
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('LEDGER_CONFIG_INVALID');

  function getNextOffset() {
    try {
      return readNextOffset(database);
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_READ_FAILED');
    }
  }

  function getUpdate(updateId) {
    validateUpdateId(updateId);
    try {
      return mapUpdate(database.prepare('SELECT * FROM updates WHERE update_id = ?').get(updateId));
    } catch {
      fail('LEDGER_READ_FAILED');
    }
  }

  function getRequest(requestId) {
    validateIdentifier(requestId, REQUEST_ID_PATTERN);
    try {
      return mapRequest(database.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId));
    } catch {
      fail('LEDGER_READ_FAILED');
    }
  }

  function acceptBatch(input) {
    const prepared = prepareBatch(input);
    if (prepared.items.length === 0) {
      return { inserted: 0, duplicates: prepared.duplicates, nextOffset: getNextOffset() };
    }
    try {
      const transaction = database.transaction(() => {
        const existingCursor = readNextOffset(database);
        const batchCursor = (BigInt(prepared.maximum) + 1n).toString();
        const nextOffset = maxDecimal(existingCursor, batchCursor);
        const select = database.prepare(`
          SELECT payload_sha256, update_type FROM updates WHERE update_id = ?
        `);
        const insert = database.prepare(`
          INSERT INTO updates (
            update_id, next_offset, update_type, status, payload_json, payload_sha256,
            attempt, error_code, received_at, updated_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `);
        let inserted = 0;
        let duplicates = prepared.duplicates;
        for (const item of prepared.items) {
          const existing = select.get(item.updateId);
          if (existing) {
            if (
              existing.payload_sha256 !== item.payloadSha256
              || existing.update_type !== item.updateType
            ) {
              fail('UPDATE_ID_COLLISION');
            }
            duplicates += 1;
            continue;
          }
          const now = nowFrom(clock);
          const status = item.rejectErrorCode === null ? 'received' : 'rejected';
          insert.run(
            item.updateId,
            nextOffset,
            item.updateType,
            status,
            item.payloadJson,
            item.payloadSha256,
            item.rejectErrorCode,
            now,
            now,
            item.rejectErrorCode === null ? null : now,
          );
          inserted += 1;
        }
        return { inserted, duplicates, nextOffset };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function authorizeAndQueue(updateId, input = {}) {
    validateUpdateId(updateId);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('LEDGER_INPUT_INVALID');
    let snapshot;
    try {
      snapshot = {
        requestId: input.requestId,
        messageId: input.messageId,
        scopeKey: input.scopeKey,
        orderingKey: input.orderingKey,
        ownerUserId: input.ownerUserId,
        replayPolicy: input.replayPolicy,
      };
    } catch {
      fail('LEDGER_INPUT_INVALID');
    }
    const requestId = validateIdentifier(snapshot.requestId, REQUEST_ID_PATTERN);
    const messageId = validateIdentifier(snapshot.messageId, MESSAGE_ID_PATTERN);
    const scopeKey = validateIdentifier(snapshot.scopeKey, SCOPE_KEY_PATTERN);
    const orderingKey = validateIdentifier(snapshot.orderingKey, ORDERING_KEY_PATTERN);
    const ownerUserId = validateIdentifier(snapshot.ownerUserId, OWNER_USER_ID_PATTERN);
    const replayPolicy = snapshot.replayPolicy ?? 'manual';
    if (!REPLAY_POLICIES.has(replayPolicy)) fail('LEDGER_INPUT_INVALID');
    try {
      const transaction = database.transaction(() => {
        const update = database.prepare('SELECT * FROM updates WHERE update_id = ?').get(updateId);
        if (!update) fail('UPDATE_NOT_FOUND');
        const scope = database.prepare(`
          SELECT chat_id, thread_id FROM scopes WHERE scope_key = ?
        `).get(scopeKey);
        if (!scope) fail('SCOPE_NOT_FOUND');
        if (orderingKey !== `telegram:${scope.chat_id}:${scope.thread_id}`) {
          fail('SCOPE_ORDERING_MISMATCH');
        }
        if (update.initial_request_id !== null) {
          return { changed: false, currentStatus: update.status };
        }
        if (!['received', 'authorized'].includes(update.status)) {
          return { changed: false, currentStatus: update.status };
        }
        const now = nowFrom(clock);
        database.prepare(`
          UPDATE updates
          SET status = 'authorized', scope_key = ?, ordering_key = ?, updated_at = ?
          WHERE update_id = ?
        `).run(scopeKey, orderingKey, now, updateId);
        database.prepare(`
          INSERT INTO requests (
            request_id, message_id, update_id, scope_key, retry_of_request_id,
            status, error_code, started_at, finished_at, updated_at, ordering_key,
            owner_user_id, effect_state, replay_policy, worker_id, attempt, claimed_at
          ) VALUES (?, ?, ?, ?, NULL, 'queued', NULL, ?, NULL, ?, ?, ?, 'not_started', ?, NULL, 0, NULL)
        `).run(
          requestId,
          messageId,
          updateId,
          scopeKey,
          now,
          now,
          orderingKey,
          ownerUserId,
          replayPolicy,
        );
        database.prepare(`
          UPDATE updates
          SET status = 'queued', initial_request_id = ?, updated_at = ?
          WHERE update_id = ? AND initial_request_id IS NULL
        `).run(requestId, now, updateId);
        return { changed: true, request: getRequest(requestId) };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function rejectUpdate(updateId, errorCode) {
    validateUpdateId(updateId);
    const safeCode = validateErrorCode(errorCode);
    try {
      const now = nowFrom(clock);
      const result = database.prepare(`
        UPDATE updates
        SET status = 'rejected', error_code = ?, updated_at = ?, finished_at = ?
        WHERE update_id = ? AND status IN ('received', 'authorized')
      `).run(safeCode, now, now, updateId);
      if (result.changes === 1) return { changed: true };
      const current = getUpdate(updateId);
      return { changed: false, currentStatus: current?.status ?? null };
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function transitionRequest(requestId, statement, parameters = [], updateStatus = null) {
    validateIdentifier(requestId, REQUEST_ID_PATTERN);
    try {
      const transaction = database.transaction(() => {
        const result = database.prepare(statement).run(...parameters, requestId);
        if (result.changes !== 1) {
          return { changed: false, currentStatus: getRequest(requestId)?.status ?? null };
        }
        if (updateStatus !== null) {
          const request = database.prepare('SELECT update_id FROM requests WHERE request_id = ?').get(requestId);
          database.prepare(`
            UPDATE updates SET status = ?, updated_at = ?
            WHERE update_id = ? AND initial_request_id = ?
          `).run(updateStatus, nowFrom(clock), request.update_id, requestId);
        }
        return { changed: true, request: getRequest(requestId) };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function claimRequest(requestId, workerId) {
    validateIdentifier(workerId, WORKER_ID_PATTERN);
    const now = nowFrom(clock);
    return transitionRequest(requestId, `
      UPDATE requests
      SET status = 'processing', worker_id = ?, attempt = attempt + 1,
          claimed_at = ?, started_at = ?, updated_at = ?
      WHERE request_id = ? AND status = 'queued' AND effect_state = 'not_started'
    `, [workerId, now, now, now], 'processing');
  }

  function markEffectStarted(requestId) {
    return transitionRequest(requestId, `
      UPDATE requests SET effect_state = 'started', updated_at = ?
      WHERE request_id = ? AND status = 'processing' AND effect_state = 'not_started'
    `, [nowFrom(clock)]);
  }

  function markEffectUnknown(requestId) {
    return transitionRequest(requestId, `
      UPDATE requests SET effect_state = 'unknown', updated_at = ?
      WHERE request_id = ? AND status = 'processing' AND effect_state = 'started'
    `, [nowFrom(clock)]);
  }

  function completeRequest(requestId) {
    const now = nowFrom(clock);
    return transitionRequest(requestId, `
      UPDATE requests
      SET status = 'completed', effect_state = 'confirmed', worker_id = NULL,
          updated_at = ?, finished_at = ?
      WHERE request_id = ?
        AND status = 'processing'
        AND effect_state IN ('started', 'unknown')
    `, [now, now], 'completed');
  }

  function failBeforeEffect(requestId, errorCode) {
    const now = nowFrom(clock);
    return transitionRequest(requestId, `
      UPDATE requests
      SET status = 'retryable_failed', error_code = ?, worker_id = NULL,
          updated_at = ?, finished_at = ?
      WHERE request_id = ? AND status = 'processing' AND effect_state = 'not_started'
    `, [validateErrorCode(errorCode), now, now], 'retryable_failed');
  }

  function markNeedsReview(requestId, errorCode) {
    const now = nowFrom(clock);
    return transitionRequest(requestId, `
      UPDATE requests
      SET status = 'needs_review', error_code = ?, worker_id = NULL,
          updated_at = ?, finished_at = ?
      WHERE request_id = ? AND status = 'processing' AND effect_state IN ('started', 'unknown')
    `, [validateErrorCode(errorCode), now, now], 'needs_review');
  }

  function cancelRequest(requestId, errorCode = null) {
    const now = nowFrom(clock);
    return transitionRequest(requestId, `
      UPDATE requests
      SET status = 'cancelled', error_code = ?, worker_id = NULL,
          updated_at = ?, finished_at = ?
      WHERE request_id = ? AND status = 'queued' AND effect_state = 'not_started'
    `, [validateErrorCode(errorCode), now, now], 'cancelled');
  }

  function recoverInterruptedRequests() {
    try {
      const transaction = database.transaction(() => {
        const now = nowFrom(clock);
        const safe = database.prepare(`
          UPDATE requests
          SET status = 'queued', worker_id = NULL, claimed_at = NULL, updated_at = ?
          WHERE status = 'processing' AND effect_state = 'not_started'
        `).run(now).changes;
        const ambiguous = database.prepare(`
          UPDATE requests
          SET status = 'needs_review', worker_id = NULL, error_code = 'INTERRUPTED_EFFECT_UNKNOWN',
              updated_at = ?, finished_at = ?
          WHERE status = 'processing' AND effect_state IN ('started', 'unknown')
        `).run(now, now).changes;
        database.prepare(`
          UPDATE updates SET status = 'queued', updated_at = ?
          WHERE initial_request_id IN (
            SELECT request_id FROM requests WHERE status = 'queued'
          )
        `).run(now);
        database.prepare(`
          UPDATE updates SET status = 'needs_review', updated_at = ?, finished_at = ?
          WHERE initial_request_id IN (
            SELECT request_id FROM requests WHERE status = 'needs_review'
          )
        `).run(now, now);
        return { requeued: safe, needsReview: ambiguous };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function createManualRetry(originalRequestId, input = {}) {
    validateIdentifier(originalRequestId, REQUEST_ID_PATTERN);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('LEDGER_INPUT_INVALID');
    let rawRequestId;
    let rawMessageId;
    try {
      rawRequestId = input.requestId;
      rawMessageId = input.messageId;
    } catch {
      fail('LEDGER_INPUT_INVALID');
    }
    const requestId = validateIdentifier(rawRequestId, REQUEST_ID_PATTERN);
    const messageId = validateIdentifier(rawMessageId, MESSAGE_ID_PATTERN);
    try {
      const transaction = database.transaction(() => {
        const original = database.prepare('SELECT * FROM requests WHERE request_id = ?').get(originalRequestId);
        if (!original) fail('REQUEST_NOT_FOUND');
        const existing = database.prepare('SELECT * FROM requests WHERE request_id = ?').get(requestId);
        if (existing) {
          const exactRetry = (
            existing.retry_of_request_id === originalRequestId
            && existing.message_id === messageId
            && existing.update_id === original.update_id
            && existing.scope_key === original.scope_key
            && existing.ordering_key === original.ordering_key
            && existing.owner_user_id === original.owner_user_id
            && existing.status === 'queued'
            && existing.effect_state === 'not_started'
            && existing.replay_policy === 'manual'
            && existing.worker_id === null
            && existing.attempt === 0
            && existing.claimed_at === null
            && existing.error_code === null
            && existing.finished_at === null
          );
          if (exactRetry) return { changed: false, currentStatus: existing.status };
          fail('REQUEST_ID_COLLISION');
        }
        if (!['needs_review', 'retryable_failed', 'cancelled'].includes(original.status)) {
          return { changed: false, currentStatus: original.status };
        }
        const now = nowFrom(clock);
        database.prepare(`
          INSERT INTO requests (
            request_id, message_id, update_id, scope_key, retry_of_request_id,
            status, error_code, started_at, finished_at, updated_at, ordering_key,
            owner_user_id, effect_state, replay_policy, worker_id, attempt, claimed_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, ?, ?, 'not_started', 'manual', NULL, 0, NULL)
        `).run(
          requestId,
          messageId,
          original.update_id,
          original.scope_key,
          originalRequestId,
          now,
          now,
          original.ordering_key,
          original.owner_user_id,
        );
        return { changed: true, request: getRequest(requestId) };
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function listReadyRequests(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('LEDGER_INPUT_INVALID');
    try {
      return database.prepare(`
        SELECT * FROM requests
        WHERE status = 'queued' AND effect_state = 'not_started'
        ORDER BY updated_at, request_id
        LIMIT ?
      `).all(limit).map(mapRequest);
    } catch {
      fail('LEDGER_READ_FAILED');
    }
  }

  function findOwnedRequestBinding(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    let parentRequestId;
    let parentMessageId;
    try {
      parentRequestId = input.parentRequestId;
      parentMessageId = input.parentMessageId;
    } catch {
      return null;
    }
    if (
      typeof parentRequestId !== 'string' || !REQUEST_ID_PATTERN.test(parentRequestId)
      || typeof parentMessageId !== 'string' || !MESSAGE_ID_PATTERN.test(parentMessageId)
    ) {
      return null;
    }
    try {
      const row = database.prepare(`
        SELECT
          r.request_id,
          r.message_id,
          r.scope_key,
          r.owner_user_id,
          r.status,
          s.chat_id,
          s.thread_id,
          s.current_agent
        FROM requests AS r
        INNER JOIN updates AS u ON u.update_id = r.update_id
        INNER JOIN scopes AS s ON s.scope_key = r.scope_key
        WHERE r.request_id = ?
          AND r.message_id = ?
          AND r.status = 'processing'
          AND r.owner_user_id IS NOT NULL
        LIMIT 1
      `).get(parentRequestId, parentMessageId);
      if (!row) return null;
      return {
        requestId: row.request_id,
        messageId: row.message_id,
        scopeKey: row.scope_key,
        ownerUserId: row.owner_user_id,
        chatId: row.chat_id,
        threadId: row.thread_id,
        agent: row.current_agent,
        status: row.status,
      };
    } catch {
      fail('LEDGER_READ_FAILED');
    }
  }

  function validatePollerTimestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail('LEDGER_INPUT_INVALID');
    return value;
  }

  function writePollerState(sourceKey, safeErrorCode, at) {
    const timestamp = validatePollerTimestamp(at);
    try {
      database.prepare(`
        INSERT INTO dead_letters (
          dead_letter_id, source_type, source_key, scope_key, safe_error_code, created_at
        ) VALUES (?, 'poller_state', ?, NULL, ?, ?)
        ON CONFLICT(source_type, source_key) DO UPDATE SET
          safe_error_code = excluded.safe_error_code,
          created_at = excluded.created_at
      `).run(`poller-state-${sourceKey}`, sourceKey, safeErrorCode, timestamp);
      return { changed: true, at: timestamp };
    } catch (error) {
      if (error instanceof UpdateLedgerError) throw error;
      fail('LEDGER_WRITE_FAILED');
    }
  }

  function recordPollerSuccess(at) {
    return writePollerState('last_success', 'POLL_SUCCESS', at);
  }

  function recordDuplicatePoller(at) {
    return writePollerState('duplicate_poller', 'DUPLICATE_POLLER', at);
  }

  function getPollerState() {
    try {
      const rows = database.prepare(`
        SELECT source_key, safe_error_code, created_at
        FROM dead_letters
        WHERE source_type = 'poller_state'
          AND source_key IN ('last_success', 'duplicate_poller')
      `).all();
      const byKey = new Map(rows.map((row) => [row.source_key, row]));
      const success = byKey.get('last_success');
      const duplicate = byKey.get('duplicate_poller');
      return {
        lastSuccessAt: success?.safe_error_code === 'POLL_SUCCESS' ? success.created_at : null,
        duplicatePollerAt: duplicate?.safe_error_code === 'DUPLICATE_POLLER'
          ? duplicate.created_at
          : null,
      };
    } catch {
      fail('LEDGER_READ_FAILED');
    }
  }

  return Object.freeze({
    acceptBatch,
    authorizeAndQueue,
    cancelRequest,
    claimRequest,
    completeRequest,
    createManualRetry,
    failBeforeEffect,
    findOwnedRequestBinding,
    getNextOffset,
    getPollerState,
    getRequest,
    getUpdate,
    listReadyRequests,
    markEffectStarted,
    markEffectUnknown,
    markNeedsReview,
    recordDuplicatePoller,
    recordPollerSuccess,
    recoverInterruptedRequests,
    rejectUpdate,
  });
}

module.exports = {
  UpdateLedgerError,
  createUpdateLedgerForDatabase,
};
