'use strict';

const { normalizeVcpRichText } = require('./richTextNormalizer');
const { createVcpVisibleTextFilter } = require('./vcpVisibleTextFilter');
const { validateMediaDescriptors } = require('./completionStore');
const {extractAsyncResultText}=require('./asyncResultText');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildTelegramSegments } = require('./streamRenderer');

const ERROR_MESSAGE = 'Telegram asynchronous delivery failed.';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class AsyncDeliveryError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'AsyncDeliveryError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AsyncDeliveryError);
  }
}

function fail(code) {
  throw new AsyncDeliveryError(code);
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function nowFrom(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('ASYNC_CLOCK_INVALID');
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotEvent(event, type) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  let eventType;
  let data;
  try { eventType = event.type; data = event.data; } catch { return null; }
  if (eventType !== type || data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  let correlationVersion;
  let pluginName;
  let taskId;
  let parentRequestId;
  let parentMessageId;
  try {
    correlationVersion = data.correlationVersion;
    pluginName = data.pluginName;
    taskId = data.taskId;
    parentRequestId = data.parentRequestId;
    parentMessageId = data.parentMessageId;
  } catch { return null; }
  if (
    correlationVersion !== 1
    || typeof pluginName !== 'string' || !ID_PATTERN.test(pluginName)
    || typeof taskId !== 'string' || !ID_PATTERN.test(taskId)
    || (type === 'async_task_receipt' && (
      typeof parentRequestId !== 'string' || !ID_PATTERN.test(parentRequestId)
      || typeof parentMessageId !== 'string' || !ID_PATTERN.test(parentMessageId)
    ))
    || (type === 'async_task_completed' && parentRequestId !== undefined
      && (typeof parentRequestId !== 'string' || !ID_PATTERN.test(parentRequestId)))
  ) return null;
  return Object.freeze({
    pluginName, taskId,
    taskKey: `${pluginName}:${taskId}`,
    parentRequestId,
    parentMessageId,
  });
}

function normalizeMessageId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return String(value);
  }
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function createAsyncDelivery(options = {}) {
  const mediaBridge = options.mediaBridge ?? null;
  let database;
  let ledger;
  let telegramClient;
  let asyncResultsDir;
  let proactiveEnabled;
  let maxResultBytes;
  let clock;
  try {
    database = options.database;
    ledger = options.ledger;
    telegramClient = options.telegramClient;
    asyncResultsDir = options.asyncResultsDir;
    proactiveEnabled = options.proactiveEnabled;
    maxResultBytes = options.maxResultBytes;
    clock = options.clock ?? Date.now;
  } catch { fail('ASYNC_CONFIG_INVALID'); }
  if (
    !database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function'
    || !ledger || typeof ledger.findOwnedRequestBinding !== 'function'
    || !telegramClient || typeof telegramClient.sendMessage !== 'function'
    || typeof asyncResultsDir !== 'string'
    || typeof proactiveEnabled !== 'boolean'
    || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > 16 * 1024 * 1024
    || typeof clock !== 'function'
  ) fail('ASYNC_CONFIG_INVALID');
  let physicalResultsRoot;
  try {
    const lexical = path.resolve(asyncResultsDir);
    const stat = fs.lstatSync(lexical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ASYNC_CONFIG_INVALID');
    physicalResultsRoot = fs.realpathSync.native(lexical);
  } catch (error) {
    if (error instanceof AsyncDeliveryError) throw error;
    fail('ASYNC_CONFIG_INVALID');
  }

  try {
    database.prepare(`
      UPDATE deliveries SET status = 'needs_review', effect_state = 'unknown',
        last_error_code = 'INTERRUPTED_ASYNC_DELIVERY', updated_at = ?
      WHERE source_type = 'async_task' AND status = 'sending' AND effect_state = 'started'
    `).run(nowFrom(clock));
  } catch { fail('ASYNC_STATE_FAILED'); }

  function handleReceipt(rawEvent) {
    const event = snapshotEvent(rawEvent, 'async_task_receipt');
    if (!event) return Object.freeze({ status: 'ignored' });
    let binding;
    try {
      binding = ledger.findOwnedRequestBinding({
        parentRequestId: event.parentRequestId,
        parentMessageId: event.parentMessageId,
      });
    } catch { return Object.freeze({ status: 'ignored' }); }
    if (
      !binding || binding.requestId !== event.parentRequestId
      || binding.messageId !== event.parentMessageId
      || binding.status !== 'processing'
      || typeof binding.scopeKey !== 'string'
    ) return Object.freeze({ status: 'ignored' });
    try {
      const now = nowFrom(clock);
      database.prepare(`
        INSERT INTO async_tasks (
          task_key, plugin_name, task_id, request_id, scope_key,
          correlation_version, status, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 1, 'registered', ?, ?, NULL)
        ON CONFLICT(task_key) DO NOTHING
      `).run(
        event.taskKey, event.pluginName, event.taskId,
        binding.requestId, binding.scopeKey, now, now,
      );
      const row = database.prepare('SELECT * FROM async_tasks WHERE task_key = ?').get(event.taskKey);
      if (
        !row || row.plugin_name !== event.pluginName || row.task_id !== event.taskId
        || row.request_id !== binding.requestId || row.scope_key !== binding.scopeKey
      ) return Object.freeze({ status: 'ignored' });
      return Object.freeze({ status: 'registered', taskKey: event.taskKey });
    } catch { fail('ASYNC_STATE_FAILED'); }
  }

  function readTrustedResult(pluginName, taskId) {
    const fileName = `${pluginName}-${taskId}.json`;
    const lexical = path.join(physicalResultsRoot, fileName);
    let fileHandle = null;
    try {
      const stat = fs.lstatSync(lexical);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxResultBytes) {
        fail('ASYNC_RESULT_PATH_UNSAFE');
      }
      const physical = fs.realpathSync.native(lexical);
      if (!isContained(physicalResultsRoot, physical)) fail('ASYNC_RESULT_PATH_UNSAFE');
      fileHandle = fs.openSync(lexical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(fileHandle);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxResultBytes) {
        fail('ASYNC_RESULT_PATH_UNSAFE');
      }
      const raw = fs.readFileSync(fileHandle, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > maxResultBytes) fail('ASYNC_RESULT_TOO_LARGE');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('ASYNC_RESULT_INVALID');
      const candidate = extractAsyncResultText(parsed);
      if (!candidate || Buffer.byteLength(candidate, 'utf8') > maxResultBytes) {
        fail('ASYNC_RESULT_INVALID');
      }
      return { text: candidate, parsed };
    } catch (error) {
      if (error instanceof AsyncDeliveryError) throw error;
      fail('ASYNC_RESULT_PATH_UNSAFE');
    } finally {
      if (fileHandle !== null) try { fs.closeSync(fileHandle); } catch { /* best effort */ }
    }
  }

  function handleCompleted(rawEvent) {
    const event = snapshotEvent(rawEvent, 'async_task_completed');
    if (!event) return Object.freeze({ status: 'ignored' });
    let task;
    try {
      task = database.prepare(`
        SELECT a.*, r.owner_user_id, s.chat_id, s.thread_id
        FROM async_tasks AS a
        JOIN requests AS r ON r.request_id = a.request_id
        JOIN scopes AS s ON s.scope_key = a.scope_key
        WHERE a.task_key = ? AND a.correlation_version = 1
      `).get(event.taskKey);
    } catch { fail('ASYNC_STATE_FAILED'); }
    if (!task || (event.parentRequestId !== undefined && event.parentRequestId !== task.request_id)) {
      return Object.freeze({ status: 'ignored' });
    }
    if (task.plugin_name !== event.pluginName || task.task_id !== event.taskId) {
      return Object.freeze({ status: 'ignored' });
    }
    if (task.owner_user_id !== task.chat_id || !/^[1-9]\d*$/.test(task.owner_user_id)) {
      return Object.freeze({ status: 'ignored' });
    }
    if (['delivered','completed','completed_with_errors'].includes(task.status)) {
      return Object.freeze({ status: 'queued', taskKey: event.taskKey });
    }
    const result = readTrustedResult(event.pluginName, event.taskId);
    const filter = createVcpVisibleTextFilter();
    const visible = filter.push(result.text) + filter.finish();
    const document = normalizeVcpRichText(visible);
    const text = document.text + (document.media.length > 0 && mediaBridge === null
      ? '\n\n（异步结果中的图片暂未投递，可请 Agent 单独发送。）' : '');
    if (!text.trim()) fail('ASYNC_RESULT_INVALID');
    const segments = buildTelegramSegments(text, { maxChars: 4096 });
    try {
      const transaction = database.transaction(() => {
        const now = nowFrom(clock);
        const insertDelivery = database.prepare(`
          INSERT INTO deliveries (
            idempotency_key, scope_key, kind, source_type, source_key,
            status, attempt, last_error_code, next_attempt_at,
            telegram_message_id, created_at, updated_at, delivered_at,
            segment_index, payload_json, payload_sha256, effect_state
          ) VALUES (?, ?, 'async_result', 'async_task', ?, 'pending', 0,
            NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, 'not_started')
          ON CONFLICT(idempotency_key) DO NOTHING
        `);
        segments.forEach((segment, index) => {
          const payload = JSON.stringify({
            text: segment.text,
            plainText: segment.plainText,
            parseMode: segment.parseMode,
            chatId: task.chat_id,
            threadId: task.thread_id,
            requestId: task.request_id,
            pluginName: task.plugin_name,
            taskId: task.task_id,
            segmentIndex: index,
          });
          const deliveryKey = `async-${sha256(`${event.taskKey}\0${task.request_id}\0${index}`)}`;
          insertDelivery.run(
            deliveryKey, task.scope_key, event.taskKey, now, now,
            index, payload, sha256(payload),
          );
        });
        database.prepare(`
          UPDATE async_tasks SET status = 'completed', updated_at = ?, completed_at = ?
          WHERE task_key = ? AND status = 'registered'
        `).run(now, now, event.taskKey);
      });
      transaction.immediate();
      return Object.freeze({ status: 'queued', taskKey: event.taskKey });
    } catch (error) {
      if (error instanceof AsyncDeliveryError) throw error;
      fail('ASYNC_STATE_FAILED');
    }
  }

  function transitionFailure(row, error) {
    const now = nowFrom(clock);
    // Artifact validation has no Telegram effect; transport failures remain unknown.
    const localRejected = error?.code?.startsWith('ASYNC_ARTIFACT_') === true;
    const code = localRejected ? 'ASYNC_ARTIFACT_REJECTED' : error?.code;
    if (error?.code === 'TELEGRAM_RATE_LIMIT' && Number.isSafeInteger(error.retryAfterSec) && error.retryAfterSec >= 0) {
      database.prepare(`
        UPDATE deliveries SET status = 'retrying', effect_state = 'not_started',
          last_error_code = 'TELEGRAM_RATE_LIMIT', next_attempt_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'sending'
      `).run(now + (error.retryAfterSec * 1000), now, row.idempotency_key);
      return 'retrying';
    }
    if (localRejected || ['TELEGRAM_FORBIDDEN', 'TELEGRAM_BAD_REQUEST'].includes(code)) {
      const transaction = database.transaction(() => {
        database.prepare(`
          UPDATE deliveries SET status = 'dead_letter', effect_state = 'confirmed',
            last_error_code = ?, updated_at = ? WHERE idempotency_key = ?
        `).run(code, now, row.idempotency_key);
        database.prepare(`
          INSERT INTO dead_letters (
            dead_letter_id, source_type, source_key, scope_key, safe_error_code, created_at
          ) VALUES (?, 'async_delivery', ?, ?, ?, ?)
          ON CONFLICT(source_type, source_key) DO NOTHING
        `).run(`async-dead-${sha256(row.idempotency_key)}`, row.idempotency_key, row.scope_key, code, now);
        if (localRejected && row.source_type === 'async_task') {
          const original = JSON.parse(row.payload_json);
          const text = '部分任务附件在发送前已变化或无法读取，未发送；其他有效附件会继续投递。';
          const payload = JSON.stringify({chatId:original.chatId,threadId:original.threadId,text,plainText:text,parseMode:null});
          const index = database.prepare("SELECT COALESCE(MAX(segment_index),-1)+1 n FROM deliveries WHERE source_type='async_task' AND source_key=?").get(row.source_key).n;
          database.prepare(`INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,status,
            attempt,created_at,updated_at,segment_index,payload_json,payload_sha256,effect_state)
            VALUES(?,?,'async_result','async_task',?,'pending',0,?,?,?,?,?,'not_started') ON CONFLICT(idempotency_key) DO NOTHING`)
            .run('async-local-note-'+sha256(row.source_key),row.scope_key,row.source_key,now,now,index,payload,sha256(payload));
        }
      });
      transaction.immediate();
      return 'dead_letter';
    }
    database.prepare(`
      UPDATE deliveries SET status = 'needs_review', effect_state = 'unknown',
        last_error_code = 'TELEGRAM_NETWORK_UNKNOWN', updated_at = ?
      WHERE idempotency_key = ? AND status = 'sending'
    `).run(now, row.idempotency_key);
    return 'needs_review';
  }

  async function processDue(limit, controls = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('ASYNC_INPUT_INVALID');
    const canDeliver = () => !controls.signal?.aborted && database.open !== false
      && (typeof controls.canDeliver !== 'function' || controls.canDeliver() === true);
    if (!canDeliver()) return Object.freeze({ delivered: 0, retrying: 0, deadLetters: 0, needsReview: 0 });
    const tasks = database.prepare(`SELECT a.*,s.chat_id,s.thread_id FROM async_tasks a
      JOIN scopes s ON s.scope_key=a.scope_key
      WHERE a.status='completed' AND a.media_prepared=0 ORDER BY a.created_at LIMIT 20`).all();
    for (const task of tasks) {
      if (!canDeliver()) break;
      const resources = [];
      let unavailable = 0;
      if (mediaBridge) {
        try {
          const filter = createVcpVisibleTextFilter();
          const doc = normalizeVcpRichText(filter.push(readTrustedResult(task.plugin_name, task.task_id).text) + filter.finish());
          for (const candidate of doc.media.slice(0, 20)) {
            if (!canDeliver()) break;
            try {
              const resolved = validateMediaDescriptors([await mediaBridge.resolve(candidate, { signal: controls.signal })]);
              resources.push(...resolved);
            }
            catch { unavailable++; }
          }
        } catch { unavailable++; }
      }
      if (!canDeliver()) break;
      database.transaction(() => {
        const timestamp = nowFrom(clock);
        const firstIndex = database.prepare(`SELECT COALESCE(MAX(segment_index),-1)+1 n FROM deliveries
          WHERE source_type='async_task' AND source_key=?`).get(task.task_key).n;
        const insert = database.prepare(`INSERT INTO deliveries(idempotency_key,scope_key,kind,source_type,source_key,
          status,attempt,created_at,updated_at,segment_index,payload_json,payload_sha256,effect_state)
          VALUES(?,?,?,'async_task',?,'pending',0,?,?,?,?,?,'not_started') ON CONFLICT(idempotency_key) DO NOTHING`);
        for (let index=0;index<resources.length;index++) {
          const payload = JSON.stringify({ chatId: task.chat_id, threadId: task.thread_id, requestId: task.request_id, media: resources[index] });
          insert.run('async-media-'+sha256(task.task_key+'\0'+task.request_id+'\0'+index), task.scope_key,
            'async_media', task.task_key, timestamp,timestamp,firstIndex+index,payload,sha256(payload));
        }
        if (unavailable > 0) {
          const text='部分任务附件暂时无法发送，文字结果已保留。';
          const payload=JSON.stringify({chatId:task.chat_id,threadId:task.thread_id,text,plainText:text,parseMode:null});
          insert.run('async-media-note-'+sha256(task.task_key), task.scope_key,'async_result',task.task_key,
            timestamp,timestamp,firstIndex+resources.length,payload,sha256(payload));
        }
        database.prepare('UPDATE async_tasks SET media_prepared=1 WHERE task_key=?').run(task.task_key);
      }).immediate();
    }
    const now = nowFrom(clock);
    const rows = database.prepare(`
      SELECT * FROM deliveries
      WHERE source_type IN ('async_task','proactive')
        AND (source_type <> 'async_task' OR EXISTS(SELECT 1 FROM async_tasks a
          WHERE a.task_key=deliveries.source_key AND a.media_prepared=1))
        AND status IN ('pending','retrying')
        AND effect_state = 'not_started'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at, source_key, segment_index, idempotency_key LIMIT ?
    `).all(now, limit);
    const counts = { delivered: 0, retrying: 0, deadLetters: 0, needsReview: 0 };
    for (const row of rows) {
      if (!canDeliver()) break;
      if (row.source_type === 'async_task') {
        const prior = database.prepare(`SELECT COUNT(*) n FROM deliveries WHERE source_type='async_task'
          AND source_key=? AND segment_index < ? AND status <> 'delivered'
          AND NOT(status='dead_letter' AND effect_state='confirmed' AND kind='async_media'
            AND last_error_code='ASYNC_ARTIFACT_REJECTED')`).get(row.source_key,row.segment_index).n;
        if (prior > 0) continue;
      }
      const claimed = database.prepare(`
        UPDATE deliveries SET status = 'sending', effect_state = 'started',
          attempt = attempt + 1, updated_at = ?
        WHERE idempotency_key = ? AND status IN ('pending','retrying')
          AND effect_state = 'not_started'
      `).run(nowFrom(clock), row.idempotency_key);
      if (claimed.changes !== 1) continue;
      let payload;
      try { payload = JSON.parse(row.payload_json); }
      catch {
        transitionFailure(row, { code: 'TELEGRAM_BAD_REQUEST' });
        counts.deadLetters += 1;
        continue;
      }
      try {
        let response;
        try {
          if (row.kind === 'async_media') {
            if (payload.artifact || !payload.media || !mediaBridge) {
              throw Object.assign(new Error('Unsupported persisted media descriptor.'), { code: 'ASYNC_ARTIFACT_UNSUPPORTED' });
            }
            const mediaResult = await mediaBridge.send({chatId:payload.chatId,threadId:payload.threadId,
              media:payload.media,signal:controls.signal});
            response = {message_id:mediaResult.messageId};
          } else response = await telegramClient.sendMessage({
            chat_id: payload.chatId,
            message_thread_id: payload.threadId,
            text: payload.text,
            ...(payload.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
          }, { signal: controls.signal });
        } catch (error) {
          if (!canDeliver()) throw error;
          if (error?.code !== 'TELEGRAM_BAD_REQUEST' || payload.parseMode !== 'HTML') throw error;
          response = await telegramClient.sendMessage({
            chat_id: payload.chatId,
            message_thread_id: payload.threadId,
            text: payload.plainText,
          }, { signal: controls.signal });
        }
        if (database.open === false) break;
        const messageId = normalizeMessageId(response?.message_id);
        if (!messageId) throw new Error('unknown Telegram response');
        const timestamp = nowFrom(clock);
        const transaction = database.transaction(() => {
          database.prepare(`
            UPDATE deliveries SET status = 'delivered', effect_state = 'confirmed',
              telegram_message_id = ?, updated_at = ?, delivered_at = ?
            WHERE idempotency_key = ? AND status = 'sending' AND effect_state = 'started'
          `).run(messageId, timestamp, timestamp, row.idempotency_key);
          if (row.source_type === 'async_task') {
            const remaining = database.prepare(`
              SELECT COUNT(*) AS count FROM deliveries
              WHERE source_type = 'async_task' AND source_key = ? AND status != 'delivered'
                AND NOT(status='dead_letter' AND effect_state='confirmed' AND kind='async_media'
                  AND last_error_code='ASYNC_ARTIFACT_REJECTED')
            `).get(row.source_key).count;
            if (remaining === 0) {
              database.prepare(`
                UPDATE async_tasks SET status = CASE WHEN EXISTS(SELECT 1 FROM deliveries
                  WHERE source_type='async_task' AND source_key=async_tasks.task_key AND status='dead_letter')
                  THEN 'completed_with_errors' ELSE 'delivered' END,
                  updated_at = ? WHERE task_key = ? AND media_prepared=1
              `).run(timestamp, row.source_key);
            }
          }
        });
        transaction.immediate();
        counts.delivered += 1;
      } catch (error) {
        if (database.open === false) break;
        const state = transitionFailure(row, error);
        if (state === 'retrying') counts.retrying += 1;
        else if (state === 'dead_letter') counts.deadLetters += 1;
        else counts.needsReview += 1;
      }
    }
    return Object.freeze(counts);
  }

  function enqueueProactive(input = {}) {
    if (!proactiveEnabled) return Object.freeze({ status: 'ignored' });
    let scopeKey;
    let ownerUserId;
    let text;
    try { scopeKey = input.scopeKey; ownerUserId = input.ownerUserId; text = input.text; }
    catch { fail('ASYNC_INPUT_INVALID'); }
    const scope = database.prepare('SELECT chat_id, thread_id FROM scopes WHERE scope_key = ?').get(scopeKey);
    if (!scope || scope.chat_id !== ownerUserId || !/^[1-9]\d*$/.test(ownerUserId) || typeof text !== 'string' || text === '') {
      return Object.freeze({ status: 'ignored' });
    }
    const segments = buildTelegramSegments(text, { maxChars: 4096 });
    const sourceKey = `proactive-${sha256(`${scopeKey}\0${text}`).slice(0, 40)}`;
    try {
      const transaction = database.transaction(() => {
        const timestamp = nowFrom(clock);
        const insert = database.prepare(`
          INSERT INTO deliveries (
            idempotency_key, scope_key, kind, source_type, source_key,
            status, attempt, last_error_code, next_attempt_at,
            telegram_message_id, created_at, updated_at, delivered_at,
            segment_index, payload_json, payload_sha256, effect_state
          ) VALUES (?, ?, 'proactive', 'proactive', ?, 'pending', 0,
            NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, 'not_started')
          ON CONFLICT(idempotency_key) DO NOTHING
        `);
        segments.forEach((segment, index) => {
          const payload = JSON.stringify({
            text: segment.text, plainText: segment.plainText, parseMode: segment.parseMode,
            chatId: scope.chat_id, threadId: scope.thread_id, segmentIndex: index,
          });
          insert.run(
            `proactive-${sha256(`${sourceKey}\0${index}`)}`,
            scopeKey, sourceKey, timestamp, timestamp, index, payload, sha256(payload),
          );
        });
      });
      transaction.immediate();
      return Object.freeze({ status: 'queued', sourceKey });
    } catch { fail('ASYNC_STATE_FAILED'); }
  }

  let recoveryCursor = '';
  function recoverResults(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('ASYNC_INPUT_INVALID');
    let rows;
    try {
      rows = database.prepare(`
        SELECT plugin_name, task_id, request_id, task_key FROM async_tasks
        WHERE status = 'registered' AND task_key > ? ORDER BY task_key LIMIT ?
      `).all(recoveryCursor, limit);
      recoveryCursor = rows.length === limit ? rows.at(-1).task_key : '';
    } catch { fail('ASYNC_STATE_FAILED'); }
    let queued = 0;
    for (const row of rows) {
      const expected = path.join(physicalResultsRoot, `${row.plugin_name}-${row.task_id}.json`);
      if (!fs.existsSync(expected)) continue;
      let result;
      try { result = handleCompleted({
        type: 'async_task_completed',
        data: {
          correlationVersion: 1,
          pluginName: row.plugin_name,
          taskId: row.task_id,
          parentRequestId: row.request_id,
        },
      }); } catch { continue; }
      if (result.status === 'queued') queued += 1;
    }
    return Object.freeze({ queued });
  }

  function snapshot() {
    const tasks = database.prepare('SELECT status, COUNT(*) AS count FROM async_tasks GROUP BY status').all();
    return Object.freeze({ tasks: Object.freeze(Object.fromEntries(tasks.map((row) => [row.status, row.count]))) });
  }

  return Object.freeze({
    enqueueProactive,
    handleCompleted,
    handleReceipt,
    processDue,
    recoverResults,
    snapshot,
  });
}

module.exports = Object.freeze({ AsyncDeliveryError, createAsyncDelivery });
