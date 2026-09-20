'use strict';

const crypto = require('node:crypto');

const ERROR_MESSAGE = 'Telegram completion persistence failed.';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const TELEGRAM_MESSAGE_ID_PATTERN = /^[1-9]\d*$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNSAFE_TEXT_PATTERN = /(?:<<<\[?(?:TOOL_REQUEST|TOOL_RESULT|ROLE_DIVIDE_(?:SYSTEM|USER))|<<<DAILYNOTESTART>>>|<\/?(?:think|thinking|reasoning)\b|\[(?:UPSTREAM_ERROR|ERROR)\]|\[上游响应超时，流已中断\]|VCP_TOOL_PAYLOAD|\[本轮工具调用摘要:])/i;

class CompletionStoreError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'CompletionStoreError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, CompletionStoreError);
  }
}

function fail(code) {
  throw new CompletionStoreError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotRecord(value, allowed, required, code) {
  if (!isPlainRecord(value)) fail(code);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(code); }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) fail(code);
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail(code);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || Object.hasOwn(descriptor, 'get')
      || Object.hasOwn(descriptor, 'set')
    ) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotArray(value, maximum, code) {
  if (!Array.isArray(value)) fail(code);
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(code); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum) fail(code);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function nowFrom(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('COMPLETION_CLOCK_INVALID');
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalPayload(segment, index, input = {}) {
  return JSON.stringify({
    text: segment.text,
    plainText: segment.plainText,
    parseMode: segment.parseMode,
    segmentIndex: index,
    ...(index === 0 && input.previewMessageId !== undefined ? { previewMessageId: input.previewMessageId } : {}),
    ...(index === 0 && input.previewDeliveryUnknown ? { previewDeliveryUnknown: true } : {}),
  });
}

function canonicalMediaPayload(media, index) {
  return JSON.stringify({
    mediaKind: media.mediaKind,
    relativePath: media.relativePath,
    mime: media.mime,
    size: media.size,
    sha256: media.sha256,
    alt: media.alt,
    mediaIndex: index,
    ...(media.storageRoot ? { storageRoot: media.storageRoot } : {}),
  });
}

function completionHash(input) {
  return sha256(JSON.stringify({
    turnId: input.turnId,
    userText: input.userText,
    assistantText: input.assistantText,
    userTelegramMessageId: input.userTelegramMessageId,
    segments: input.segments.map((segment, index) => JSON.parse(canonicalPayload(segment, index, input))),
    media: input.media.map((item, index) => JSON.parse(canonicalMediaPayload(item, index))),
  }));
}

function validateSafeAssistantText(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value === '…'
    || value === '...'
    || UNSAFE_TEXT_PATTERN.test(value)
  ) fail('COMPLETION_TEXT_UNSAFE');
  return value;
}

function snapshotSegments(raw, assistantText) {
  const values = snapshotArray(raw, 100, 'COMPLETION_INPUT_INVALID');
  const segments = values.map((rawSegment) => {
    const segment = snapshotRecord(
      rawSegment,
      new Set(['text', 'plainText', 'parseMode']),
      ['text', 'plainText', 'parseMode'],
      'COMPLETION_INPUT_INVALID',
    );
    if (
      typeof segment.text !== 'string'
      || segment.text === ''
      || typeof segment.plainText !== 'string'
      || segment.plainText === ''
      || ![null, 'HTML'].includes(segment.parseMode)
    ) fail('COMPLETION_INPUT_INVALID');
    return Object.freeze({
      text: segment.text,
      plainText: segment.plainText,
      parseMode: segment.parseMode,
    });
  });
  if (segments.map((segment) => segment.plainText).join('') !== assistantText) {
    fail('COMPLETION_SEGMENT_MISMATCH');
  }
  return Object.freeze(segments);
}

function snapshotMedia(raw) {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) fail('COMPLETION_INPUT_INVALID');
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(raw); } catch { fail('COMPLETION_INPUT_INVALID'); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 20) fail('COMPLETION_INPUT_INVALID');
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const entry = descriptors[String(index)];
    if (!entry || !Object.hasOwn(entry, 'value') || entry.enumerable !== true) {
      fail('COMPLETION_INPUT_INVALID');
    }
    const item = snapshotRecord(
      entry.value,
      new Set(['mediaKind', 'relativePath', 'mime', 'size', 'sha256', 'alt', 'storageRoot']),
      ['mediaKind', 'relativePath', 'mime', 'size', 'sha256', 'alt'],
      'COMPLETION_INPUT_INVALID',
    );
    const pathSegments = typeof item.relativePath === 'string' ? item.relativePath.split('/') : [];
    if (
      !['photo', 'animation', 'document'].includes(item.mediaKind)
      || (item.storageRoot !== undefined && item.storageRoot !== 'outbox')
      || typeof item.relativePath !== 'string' || item.relativePath.length < 1 || item.relativePath.length > 1024
      || pathSegments.some((segment) => (
        segment === '' || segment === '.' || segment === '..'
        || /[\\\u0000-\u001f\u007f-\u009f]/.test(segment)
      ))
      || (item.mediaKind === 'document'
        ? (item.storageRoot !== 'outbox' || typeof item.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(item.mime))
        : !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mime))
      || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 50_000_000
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.alt !== 'string' || item.alt.length > 160
      || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/i.test(item.alt)
    ) fail('COMPLETION_INPUT_INVALID');
    result.push(Object.freeze({
      mediaKind: item.mediaKind,
      relativePath: item.relativePath,
      mime: item.mime,
      size: item.size,
      sha256: item.sha256,
      alt: item.alt,
      ...(item.storageRoot ? { storageRoot: item.storageRoot } : {}),
    }));
  }
  return Object.freeze(result);
}

function snapshotCompletionInput(raw) {
  const value = snapshotRecord(
    raw,
    new Set([
      'requestId', 'turnId', 'userText', 'assistantText',
      'userTelegramMessageId', 'segments', 'media', 'previewMessageId', 'previewDeliveryUnknown',
    ]),
    ['requestId', 'turnId', 'userText', 'assistantText', 'segments'],
    'COMPLETION_INPUT_INVALID',
  );
  if (
    typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)
    || typeof value.turnId !== 'string' || !TURN_ID_PATTERN.test(value.turnId)
    || typeof value.userText !== 'string' || value.userText === ''
    || (value.userTelegramMessageId !== undefined
      && (typeof value.userTelegramMessageId !== 'string'
        || !TELEGRAM_MESSAGE_ID_PATTERN.test(value.userTelegramMessageId)))
    || (value.previewMessageId !== undefined
      && (typeof value.previewMessageId !== 'string' || !TELEGRAM_MESSAGE_ID_PATTERN.test(value.previewMessageId)))
    || (value.previewDeliveryUnknown !== undefined && value.previewDeliveryUnknown !== true)
    || (value.previewMessageId !== undefined && value.previewDeliveryUnknown === true)
  ) fail('COMPLETION_INPUT_INVALID');
  const assistantText = validateSafeAssistantText(value.assistantText);
  return Object.freeze({
    requestId: value.requestId,
    turnId: value.turnId,
    userText: value.userText,
    assistantText,
    userTelegramMessageId: value.userTelegramMessageId ?? null,
    segments: snapshotSegments(value.segments, assistantText),
    media: snapshotMedia(value.media),
    ...(value.previewMessageId === undefined ? {} : { previewMessageId: value.previewMessageId }),
    ...(value.previewDeliveryUnknown ? { previewDeliveryUnknown: true } : {}),
  });
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('COMPLETION_CONFIG_INVALID');
  }
}

function draftIdFor(requestId) {
  const bytes = crypto.createHash('sha256').update('telegram-draft-v1\0').update(requestId).digest();
  const value = bytes.readUInt32BE(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

function historyBytes(role, content, telegramMessageId) {
  return Buffer.byteLength(JSON.stringify({ role, content, telegramMessageId }), 'utf8');
}

function createCompletionStore(database, options = {}) {
  validateDatabase(database);
  const clock = options.clock ?? Date.now;
  const historyMaxMessages = options.historyMaxMessages ?? 40;
  const historyMaxBytes = options.historyMaxBytes ?? 262144;
  if (
    typeof clock !== 'function'
    || !Number.isSafeInteger(historyMaxMessages) || historyMaxMessages < 2 || historyMaxMessages > 200
    || !Number.isSafeInteger(historyMaxBytes) || historyMaxBytes < 1 || historyMaxBytes > 1048576
  ) fail('COMPLETION_CONFIG_INVALID');

  function getOrCreateDraftId(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      fail('COMPLETION_INPUT_INVALID');
    }
    try {
      const transaction = database.transaction(() => {
        const request = database.prepare(`
          SELECT telegram_draft_id FROM requests WHERE request_id = ?
        `).get(requestId);
        if (!request) fail('COMPLETION_REQUEST_NOT_FOUND');
        if (request.telegram_draft_id !== null) return request.telegram_draft_id;
        const draftId = draftIdFor(requestId);
        database.prepare(`
          UPDATE requests SET telegram_draft_id = ?, updated_at = ?
          WHERE request_id = ? AND telegram_draft_id IS NULL
        `).run(draftId, nowFrom(clock), requestId);
        return database.prepare('SELECT telegram_draft_id FROM requests WHERE request_id = ?')
          .get(requestId).telegram_draft_id;
      });
      return transaction.immediate();
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_WRITE_FAILED');
    }
  }

  function commitCompletion(rawInput) {
    const input = snapshotCompletionInput(rawInput);
    try {
      const transaction = database.transaction(() => {
        const request = database.prepare('SELECT * FROM requests WHERE request_id = ?')
          .get(input.requestId);
        if (!request) fail('COMPLETION_REQUEST_NOT_FOUND');
        const deliveryKeys = input.segments.map((segment, index) => (
          `final-${sha256(`${input.requestId}\0${index}\0${canonicalPayload(segment, index, input)}`)}`
        ));
        const mediaDeliveryKeys = input.media.map((item, index) => (
          `media-${sha256(`${input.requestId}\0${index}\0${canonicalMediaPayload(item, index)}`)}`
        ));
        const expectedCompletionHash = completionHash(input);
        const userMessageId = `history-${sha256(`${input.requestId}\0user`).slice(0, 40)}`;
        const assistantMessageId = `history-${sha256(`${input.requestId}\0assistant`).slice(0, 40)}`;
        if (request.status === 'completed' && request.effect_state === 'confirmed') {
          const existing = database.prepare(`
            SELECT idempotency_key, payload_json FROM deliveries
            WHERE source_type = 'telegram_final' AND source_key = ?
            ORDER BY segment_index
          `).all(input.requestId);
          const existingMedia = database.prepare(`
            SELECT idempotency_key, payload_json FROM deliveries
            WHERE source_type = 'telegram_rich_media' AND source_key = ?
            ORDER BY segment_index
          `).all(input.requestId);
          if (
            request.completion_sha256 === expectedCompletionHash
            &&
            existing.length === deliveryKeys.length
            && existing.every((row, index) => (
              row.idempotency_key === deliveryKeys[index]
              && row.payload_json === canonicalPayload(input.segments[index], index, input)
            ))
            && existingMedia.length === mediaDeliveryKeys.length
            && existingMedia.every((row, index) => (
              row.idempotency_key === mediaDeliveryKeys[index]
              && row.payload_json === canonicalMediaPayload(input.media[index], index)
            ))
          ) return { changed: false, deliveryKeys, mediaDeliveryKeys };
          fail('COMPLETION_IDEMPOTENCY_COLLISION');
        }
        if (
          request.status !== 'processing'
          || !['started', 'unknown'].includes(request.effect_state)
          || typeof request.scope_key !== 'string'
        ) fail('COMPLETION_REQUEST_STATE_INVALID');
        const scope = database.prepare(`
          SELECT conversation_id FROM scopes WHERE scope_key = ?
        `).get(request.scope_key);
        if (!scope) fail('COMPLETION_SCOPE_NOT_FOUND');
        const existingTurn = database.prepare(`
          SELECT COUNT(*) AS count FROM messages
          WHERE scope_key = ? AND conversation_id = ? AND turn_id = ?
        `).get(request.scope_key, scope.conversation_id, input.turnId).count;
        if (existingTurn !== 0) fail('COMPLETION_TURN_COLLISION');
        const nextTurn = database.prepare(`
          SELECT COALESCE(MAX(turn_seq), -1) + 1 AS value FROM messages
          WHERE scope_key = ? AND conversation_id = ?
        `).get(request.scope_key, scope.conversation_id).value;
        const insertMessage = database.prepare(`
          INSERT INTO messages (
            message_id, scope_key, conversation_id, turn_id, turn_seq, position,
            role, content_json, content_bytes, telegram_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const timestamp = nowFrom(clock);
        const turnBytes = historyBytes('user', input.userText, input.userTelegramMessageId)
          + historyBytes('assistant', input.assistantText, null);
        if (turnBytes > historyMaxBytes) fail('COMPLETION_HISTORY_LIMIT');
        insertMessage.run(
          userMessageId, request.scope_key, scope.conversation_id, input.turnId,
          nextTurn, 0, 'user', JSON.stringify(input.userText),
          historyBytes('user', input.userText, input.userTelegramMessageId),
          input.userTelegramMessageId, timestamp,
        );
        insertMessage.run(
          assistantMessageId, request.scope_key, scope.conversation_id, input.turnId,
          nextTurn, 1, 'assistant', JSON.stringify(input.assistantText),
          historyBytes('assistant', input.assistantText, null), null, timestamp,
        );
        const turns = database.prepare(`
          SELECT turn_seq, COUNT(*) AS message_count, SUM(content_bytes) AS byte_count
          FROM messages WHERE scope_key = ? AND conversation_id = ?
          GROUP BY turn_seq ORDER BY turn_seq DESC
        `).all(request.scope_key, scope.conversation_id);
        let keptMessages = 0;
        let keptBytes = 0;
        const remove = [];
        let overflowed = false;
        for (const turn of turns) {
          if (
            overflowed
            || keptMessages + turn.message_count > historyMaxMessages
            || keptBytes + turn.byte_count > historyMaxBytes
          ) {
            overflowed = true;
            remove.push(turn.turn_seq);
          } else {
            keptMessages += turn.message_count;
            keptBytes += turn.byte_count;
          }
        }
        if (remove.length > 0) {
          const placeholders = remove.map(() => '?').join(', ');
          database.prepare(`
            DELETE FROM messages WHERE scope_key = ? AND conversation_id = ?
              AND turn_seq IN (${placeholders})
          `).run(request.scope_key, scope.conversation_id, ...remove);
        }
        const completed = database.prepare(`
          UPDATE requests SET status = 'completed', effect_state = 'confirmed',
            worker_id = NULL, completion_sha256 = ?, updated_at = ?, finished_at = ?
          WHERE request_id = ? AND status = 'processing'
            AND effect_state IN ('started','unknown')
        `).run(expectedCompletionHash, timestamp, timestamp, input.requestId);
        if (completed.changes !== 1) fail('COMPLETION_REQUEST_STATE_INVALID');
        database.prepare(`
          UPDATE updates SET status = 'completed', updated_at = ?, finished_at = ?
          WHERE initial_request_id = ?
        `).run(timestamp, timestamp, input.requestId);
        const insertDelivery = database.prepare(`
          INSERT INTO deliveries (
            idempotency_key, scope_key, kind, source_type, source_key, status,
            attempt, last_error_code, next_attempt_at, telegram_message_id,
            created_at, updated_at, delivered_at, segment_index,
            payload_json, payload_sha256, effect_state
          ) VALUES (?, ?, 'final_message', 'telegram_final', ?, 'pending',
            0, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, 'not_started')
        `);
        input.segments.forEach((segment, index) => {
          const payload = canonicalPayload(segment, index, input);
          insertDelivery.run(
            deliveryKeys[index], request.scope_key, input.requestId,
            timestamp, timestamp, index, payload, sha256(payload),
          );
        });
        if (input.previewDeliveryUnknown) {
          database.prepare(`UPDATE deliveries SET status = 'needs_review', effect_state = 'unknown',
            last_error_code = 'TELEGRAM_PREVIEW_UNKNOWN' WHERE idempotency_key = ?`)
            .run(deliveryKeys[0]);
        }
        const insertMediaDelivery = database.prepare(`
          INSERT INTO deliveries (
            idempotency_key, scope_key, kind, source_type, source_key, status,
            attempt, last_error_code, next_attempt_at, telegram_message_id,
            created_at, updated_at, delivered_at, segment_index,
            payload_json, payload_sha256, effect_state
          ) VALUES (?, ?, 'rich_media', 'telegram_rich_media', ?, 'pending',
            0, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, 'not_started')
        `);
        input.media.forEach((item, index) => {
          const payload = canonicalMediaPayload(item, index);
          insertMediaDelivery.run(
            mediaDeliveryKeys[index], request.scope_key, input.requestId,
            timestamp, timestamp, index, payload, sha256(payload),
          );
        });
        return { changed: true, deliveryKeys, mediaDeliveryKeys };
      });
      const result = transaction.immediate();
      const snapshot = {
        changed: result.changed,
        deliveryKeys: Object.freeze([...result.deliveryKeys]),
      };
      if (result.mediaDeliveryKeys.length > 0) {
        snapshot.mediaDeliveryKeys = Object.freeze([...result.mediaDeliveryKeys]);
      }
      return Object.freeze(snapshot);
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_WRITE_FAILED');
    }
  }

  function validateDeliveryKey(value) {
    if (typeof value !== 'string' || !/^(?:final|media|notice)-[a-f0-9]{64}$/.test(value)) {
      fail('COMPLETION_INPUT_INVALID');
    }
    return value;
  }

  function deliveryStatus(key) {
    const row = database.prepare(`
      SELECT status FROM deliveries WHERE idempotency_key = ?
    `).get(key);
    return row?.status ?? null;
  }

  function claimDelivery(idempotencyKey) {
    const key = validateDeliveryKey(idempotencyKey);
    try {
      const now = nowFrom(clock);
      const result = database.prepare(`
        UPDATE deliveries SET status = 'sending', effect_state = 'started',
          attempt = attempt + 1, updated_at = ?
        WHERE idempotency_key = ? AND status IN ('pending','retrying')
          AND effect_state = 'not_started'
          AND NOT EXISTS (
            SELECT 1 FROM deliveries AS earlier
            WHERE earlier.source_key = deliveries.source_key AND earlier.status <> 'delivered'
              AND (
                (earlier.source_type = deliveries.source_type AND earlier.segment_index < deliveries.segment_index)
                OR (deliveries.source_type = 'telegram_rich_media' AND earlier.source_type = 'telegram_final')
              )
          )
      `).run(now, key);
      return Object.freeze({ changed: result.changes === 1, status: deliveryStatus(key) });
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_WRITE_FAILED');
    }
  }

  function markDeliveryUnknown(idempotencyKey, errorCode) {
    const key = validateDeliveryKey(idempotencyKey);
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
      fail('COMPLETION_INPUT_INVALID');
    }
    try {
      const now = nowFrom(clock);
      const result = database.prepare(`
        UPDATE deliveries SET status = 'needs_review', effect_state = 'unknown',
          last_error_code = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'sending' AND effect_state = 'started'
      `).run(errorCode, now, key);
      return Object.freeze({ changed: result.changes === 1, status: deliveryStatus(key) });
    } catch {
      fail('COMPLETION_WRITE_FAILED');
    }
  }

  function markDeliveryDelivered(idempotencyKey, telegramMessageId) {
    const key = validateDeliveryKey(idempotencyKey);
    if (typeof telegramMessageId !== 'string' || !TELEGRAM_MESSAGE_ID_PATTERN.test(telegramMessageId)) {
      fail('COMPLETION_INPUT_INVALID');
    }
    try {
      const transaction = database.transaction(() => {
        const existing = database.prepare(`
          SELECT status, telegram_message_id, payload_json FROM deliveries WHERE idempotency_key = ?
        `).get(key);
        if (!existing) fail('COMPLETION_DELIVERY_NOT_FOUND');
        const previewMessageId = JSON.parse(existing.payload_json)?.previewMessageId;
        if (previewMessageId !== undefined && previewMessageId !== telegramMessageId) {
          fail('COMPLETION_IDEMPOTENCY_COLLISION');
        }
        if (existing.status === 'delivered') {
          if (existing.telegram_message_id !== telegramMessageId) {
            fail('COMPLETION_IDEMPOTENCY_COLLISION');
          }
          return { changed: false, status: 'delivered' };
        }
        const now = nowFrom(clock);
        const result = database.prepare(`
          UPDATE deliveries SET status = 'delivered', effect_state = 'confirmed',
            telegram_message_id = ?, updated_at = ?, delivered_at = ?
          WHERE idempotency_key = ? AND status = 'sending' AND effect_state = 'started'
        `).run(telegramMessageId, now, now, key);
        return { changed: result.changes === 1, status: deliveryStatus(key) };
      });
      return Object.freeze(transaction.immediate());
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_WRITE_FAILED');
    }
  }

  function listPendingDeliveries(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      fail('COMPLETION_INPUT_INVALID');
    }
    try {
      return Object.freeze(database.prepare(`
        SELECT idempotency_key, scope_key, source_key, segment_index,
          payload_json, payload_sha256, status, attempt
        FROM deliveries
        WHERE source_type = 'telegram_final'
          AND status IN ('pending','retrying')
          AND effect_state = 'not_started'
          AND NOT EXISTS (
            SELECT 1 FROM deliveries AS earlier WHERE earlier.source_key = deliveries.source_key
              AND earlier.source_type = 'telegram_final' AND earlier.segment_index < deliveries.segment_index
              AND earlier.status <> 'delivered' AND earlier.effect_state <> 'not_started'
          )
        ORDER BY created_at, segment_index
        LIMIT ?
      `).all(limit).map((row) => Object.freeze({
        idempotencyKey: row.idempotency_key,
        scopeKey: row.scope_key,
        requestId: row.source_key,
        segmentIndex: row.segment_index,
        payload: JSON.parse(row.payload_json),
        payloadSha256: row.payload_sha256,
        status: row.status,
        attempt: row.attempt,
      })));
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_READ_FAILED');
    }
  }

  function listPendingMediaDeliveries(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      fail('COMPLETION_INPUT_INVALID');
    }
    try {
      return Object.freeze(database.prepare(`
        SELECT idempotency_key, scope_key, source_key, segment_index,
          payload_json, status, attempt
        FROM deliveries
        WHERE source_type = 'telegram_rich_media'
          AND status IN ('pending','retrying')
          AND effect_state = 'not_started'
          AND NOT EXISTS (
            SELECT 1 FROM deliveries AS earlier WHERE earlier.source_key = deliveries.source_key
              AND earlier.status <> 'delivered' AND earlier.effect_state <> 'not_started'
              AND (earlier.source_type = 'telegram_final'
                OR (earlier.source_type = 'telegram_rich_media' AND earlier.segment_index < deliveries.segment_index))
          )
        ORDER BY created_at, segment_index
        LIMIT ?
      `).all(limit).map((row) => Object.freeze({
        idempotencyKey: row.idempotency_key,
        scopeKey: row.scope_key,
        requestId: row.source_key,
        mediaIndex: row.segment_index,
        payload: JSON.parse(row.payload_json),
        status: row.status,
        attempt: row.attempt,
      })));
    } catch (error) {
      if (error instanceof CompletionStoreError) throw error;
      fail('COMPLETION_READ_FAILED');
    }
  }

  return Object.freeze({
    claimDelivery,
    commitCompletion,
    getOrCreateDraftId,
    listPendingDeliveries,
    listPendingMediaDeliveries,
    markDeliveryDelivered,
    markDeliveryUnknown,
  });
}

module.exports = Object.freeze({ CompletionStoreError, createCompletionStore, validateMediaDescriptors: snapshotMedia });
