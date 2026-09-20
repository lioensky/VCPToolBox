'use strict';

const crypto = require('node:crypto');

const ERROR_MESSAGE = 'Telegram approval broker operation failed.';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const CALLBACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const CALLBACK_PATTERN = /^a1\.([ad])\.([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{8,24})$/;

class ApprovalBrokerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'ApprovalBrokerError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApprovalBrokerError);
  }
}

function fail(code) {
  throw new ApprovalBrokerError(code);
}

function nowFrom(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('APPROVAL_CLOCK_INVALID');
  return value;
}

function safeId(value, pattern = ID_PATTERN) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function normalizeTelegramId(value, signed) {
  let normalized;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    normalized = String(value);
  } else if (typeof value === 'string') normalized = value;
  else return null;
  return (signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(normalized) ? normalized : null;
}

function normalizeThreadId(value) {
  if (value === undefined) return '0';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return String(value);
  }
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : null;
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hmacTag(key, action, nonce) {
  return crypto.createHmac('sha256', key).update(`a1\0${action}\0${nonce}`).digest()
    .subarray(0, 8).toString('base64url');
}

function nonceHash(nonce) {
  return crypto.createHash('sha256').update(Buffer.from(nonce, 'base64url')).digest('hex');
}

function snapshotEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
  let type;
  let data;
  try { type = event.type; data = event.data; } catch { return null; }
  if (type !== 'tool_approval_request' || data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  let requestId;
  let parentRequestId;
  let parentMessageId;
  let correlationVersion;
  let toolName;
  let approvalTtlMs;
  try {
    requestId = data.requestId;
    parentRequestId = data.parentRequestId;
    parentMessageId = data.parentMessageId;
    correlationVersion = data.correlationVersion;
    toolName = data.toolName;
    approvalTtlMs = data.approvalTtlMs;
  } catch { return null; }
  if (
    !safeId(requestId)
    || !safeId(parentRequestId)
    || !safeId(parentMessageId)
    || correlationVersion !== 1
    || !safeId(toolName, TOOL_PATTERN)
    || !Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < 1 || approvalTtlMs > 3_600_000
  ) return null;
  return Object.freeze({
    approvalId: requestId,
    parentRequestId,
    parentMessageId,
    correlationVersion: 1,
    toolName,
    approvalTtlMs,
  });
}

function snapshotBinding(value, event) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  let requestId;
  let messageId;
  let scopeKey;
  let ownerUserId;
  let chatId;
  let threadId;
  let status;
  try {
    requestId = value.requestId;
    messageId = value.messageId;
    scopeKey = value.scopeKey;
    ownerUserId = value.ownerUserId;
    chatId = value.chatId;
    threadId = value.threadId;
    status = value.status;
  } catch { return null; }
  if (
    requestId !== event.parentRequestId
    || messageId !== event.parentMessageId
    || !safeId(scopeKey, /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*):[A-Za-z][A-Za-z0-9_.-]{0,63}$/)
    || !normalizeTelegramId(ownerUserId, false)
    || !normalizeTelegramId(chatId, true)
    || !normalizeThreadId(threadId)
    || status !== 'processing'
  ) return null;
  return Object.freeze({
    requestId,
    messageId,
    scopeKey,
    ownerUserId: normalizeTelegramId(ownerUserId, false),
    chatId: normalizeTelegramId(chatId, true),
    threadId: normalizeThreadId(threadId),
  });
}

function createApprovalBroker(options = {}) {
  let database;
  let ledger;
  let telegramClient;
  let hostIntegration;
  let clock;
  let randomBytes;
  try {
    database = options.database;
    ledger = options.ledger;
    telegramClient = options.telegramClient;
    hostIntegration = options.hostIntegration;
    clock = options.clock ?? Date.now;
    randomBytes = options.randomBytes ?? crypto.randomBytes;
  } catch { fail('APPROVAL_CONFIG_INVALID'); }
  if (
    !database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function'
    || !ledger || typeof ledger.findOwnedRequestBinding !== 'function'
    || !telegramClient || typeof telegramClient.sendMessage !== 'function'
    || typeof telegramClient.answerCallbackQuery !== 'function'
    || typeof telegramClient.editMessageText !== 'function'
    || !hostIntegration || typeof hostIntegration.respondApproval !== 'function'
    || typeof clock !== 'function' || typeof randomBytes !== 'function'
  ) fail('APPROVAL_CONFIG_INVALID');
  let epochKey;
  try { epochKey = Buffer.from(randomBytes(32)); } catch { fail('APPROVAL_CONFIG_INVALID'); }
  if (epochKey.length !== 32) fail('APPROVAL_CONFIG_INVALID');

  try {
    const now = nowFrom(clock);
    database.prepare(`
      UPDATE approvals SET status = 'invalidated_restart', updated_at = ?
      WHERE status IN ('pending','acting')
    `).run(now);
  } catch (error) {
    if (error instanceof ApprovalBrokerError) throw error;
    fail('APPROVAL_STATE_FAILED');
  }

  async function handleApprovalEvent(rawEvent) {
    const event = snapshotEvent(rawEvent);
    if (!event) return Object.freeze({ status: 'ignored' });
    let binding;
    try {
      binding = snapshotBinding(ledger.findOwnedRequestBinding({
        parentRequestId: event.parentRequestId,
        parentMessageId: event.parentMessageId,
      }), event);
    } catch { return Object.freeze({ status: 'ignored' }); }
    if (!binding) return Object.freeze({ status: 'ignored' });
    let nonceBytes;
    try { nonceBytes = Buffer.from(randomBytes(12)); } catch { fail('APPROVAL_RANDOM_FAILED'); }
    if (nonceBytes.length !== 12) fail('APPROVAL_RANDOM_FAILED');
    const nonce = nonceBytes.toString('base64url');
    const hash = nonceHash(nonce);
    const now = nowFrom(clock);
    const expiresAt = now + event.approvalTtlMs;
    if (!Number.isSafeInteger(expiresAt)) fail('APPROVAL_CLOCK_INVALID');
    const approveData = `a1.a.${nonce}.${hmacTag(epochKey, 'a', nonce)}`;
    const denyData = `a1.d.${nonce}.${hmacTag(epochKey, 'd', nonce)}`;
    try {
      database.prepare(`
        INSERT INTO approvals (
          approval_id, request_id, owner_user_id, nonce_hash, correlation_version,
          status, expires_at, created_at, updated_at, parent_message_id,
          chat_id, thread_id, telegram_message_id, tool_name, acted_at
        ) VALUES (?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        event.approvalId, binding.requestId, binding.ownerUserId, hash,
        expiresAt, now, now, binding.messageId, binding.chatId, binding.threadId,
        event.toolName,
      );
    } catch {
      return Object.freeze({ status: 'ignored' });
    }
    const text = `请求批准工具：<b>${escapeHtml(event.toolName)}</b>\n风险：需要人工确认。\n`
      + `有效期：${Math.ceil(event.approvalTtlMs / 1000)} 秒。仅批准你刚才从 Telegram 发起的这一次请求。`;
    let response;
    try {
      response = await telegramClient.sendMessage({
        chat_id: binding.chatId,
        message_thread_id: binding.threadId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '批准', callback_data: approveData },
            { text: '拒绝', callback_data: denyData },
          ]],
        },
      });
    } catch {
      database.prepare(`
        UPDATE approvals SET status = 'needs_review', updated_at = ? WHERE approval_id = ?
      `).run(nowFrom(clock), event.approvalId);
      fail('APPROVAL_TELEGRAM_UNKNOWN');
    }
    let rawMessageId;
    try { rawMessageId = response?.message_id; } catch { rawMessageId = null; }
    const messageId = normalizeTelegramId(rawMessageId, false);
    if (!messageId) {
      database.prepare(`
        UPDATE approvals SET status = 'needs_review', updated_at = ? WHERE approval_id = ?
      `).run(nowFrom(clock), event.approvalId);
      fail('APPROVAL_TELEGRAM_UNKNOWN');
    }
    database.prepare(`
      UPDATE approvals SET telegram_message_id = ?, updated_at = ?
      WHERE approval_id = ? AND status = 'pending'
    `).run(messageId, nowFrom(clock), event.approvalId);
    return Object.freeze({ status: 'sent', approvalId: event.approvalId });
  }

  function parseCallbackData(value) {
    if (typeof value !== 'string') return null;
    const match = CALLBACK_PATTERN.exec(value);
    if (!match) return null;
    const expected = hmacTag(epochKey, match[1], match[2]);
    const actualBytes = Buffer.from(match[3]);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) return null;
    return Object.freeze({ action: match[1], nonce: match[2], nonceHash: nonceHash(match[2]) });
  }

  function snapshotCallback(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    let id;
    let from;
    let data;
    let message;
    try { id = value.id; from = value.from; data = value.data; message = value.message; } catch { return null; }
    let rawUserId;
    let rawChatId;
    let rawThreadId;
    let rawMessageId;
    try {
      rawUserId = from?.id;
      rawChatId = message?.chat?.id;
      rawThreadId = message?.message_thread_id;
      rawMessageId = message?.message_id;
    } catch { return null; }
    const userId = normalizeTelegramId(rawUserId, false);
    const chatId = normalizeTelegramId(rawChatId, true);
    const threadId = normalizeThreadId(rawThreadId);
    const messageId = normalizeTelegramId(rawMessageId, false);
    if (!safeId(id, CALLBACK_ID_PATTERN) || !userId || !chatId || !threadId || !messageId) return null;
    return Object.freeze({ id, data, userId, chatId, threadId, messageId });
  }

  async function handleCallback(rawCallback) {
    let callbackId = null;
    try { callbackId = rawCallback?.id; } catch { /* invalid below */ }
    if (safeId(callbackId, CALLBACK_ID_PATTERN)) {
      try { await telegramClient.answerCallbackQuery({ callback_query_id: callbackId }); }
      catch { /* validation must still run */ }
    }
    const callback = snapshotCallback(rawCallback);
    if (!callback) return Object.freeze({ status: 'refused' });
    const parsed = parseCallbackData(callback.data);
    if (!parsed) return Object.freeze({ status: 'refused' });
    let row;
    try {
      row = database.prepare(`
        SELECT * FROM approvals WHERE nonce_hash = ? AND correlation_version = 1
      `).get(parsed.nonceHash);
    } catch { fail('APPROVAL_STATE_FAILED'); }
    if (!row) return Object.freeze({ status: 'refused' });
    const now = nowFrom(clock);
    if (row.status !== 'pending') return Object.freeze({ status: 'refused' });
    if (now > row.expires_at) {
      database.prepare(`
        UPDATE approvals SET status = 'expired', updated_at = ?
        WHERE approval_id = ? AND status = 'pending'
      `).run(now, row.approval_id);
      return Object.freeze({ status: 'expired' });
    }
    if (
      row.owner_user_id !== callback.userId
      || row.chat_id !== callback.chatId
      || row.thread_id !== callback.threadId
      || row.telegram_message_id !== callback.messageId
    ) return Object.freeze({ status: 'refused' });
    let claimed;
    try {
      const transaction = database.transaction(() => database.prepare(`
        UPDATE approvals SET status = 'acting', acted_at = ?, updated_at = ?
        WHERE approval_id = ? AND status = 'pending' AND expires_at >= ?
      `).run(now, now, row.approval_id, now));
      claimed = transaction.immediate();
    } catch { fail('APPROVAL_STATE_FAILED'); }
    if (claimed.changes !== 1) return Object.freeze({ status: 'refused' });
    const approved = parsed.action === 'a';
    let handled = false;
    try { handled = hostIntegration.respondApproval(row.approval_id, approved) === true; }
    catch { handled = false; }
    const finalStatus = handled ? (approved ? 'approved' : 'rejected') : 'failed';
    try {
      database.prepare(`
        UPDATE approvals SET status = ?, updated_at = ?
        WHERE approval_id = ? AND status = 'acting'
      `).run(finalStatus, nowFrom(clock), row.approval_id);
    } catch { fail('APPROVAL_STATE_FAILED'); }
    try {
      await telegramClient.editMessageText({
        chat_id: row.chat_id,
        message_thread_id: row.thread_id,
        message_id: row.telegram_message_id,
        text: handled
          ? `工具请求已${approved ? '批准' : '拒绝'}。`
          : '审批状态无法确认，请在 VCP 管理端检查。',
      });
    } catch { /* host decision is already final */ }
    if (!handled) return Object.freeze({ status: 'failed', approvalId: row.approval_id });
    return Object.freeze({ status: finalStatus, approvalId: row.approval_id });
  }

  function snapshot() {
    const rows = database.prepare(`
      SELECT status, COUNT(*) AS count FROM approvals GROUP BY status
    `).all();
    return Object.freeze({ counts: Object.freeze(Object.fromEntries(rows.map((row) => [row.status, row.count]))) });
  }

  function cancelRequest(requestId) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId)) return 0;
    const rows=database.prepare("SELECT approval_id FROM approvals WHERE request_id=? AND status='pending'").all(requestId);
    let count=0;
    for (const row of rows) {
      const claimed=database.prepare("UPDATE approvals SET status='cancelled',updated_at=? WHERE approval_id=? AND status='pending'").run(nowFrom(clock),row.approval_id);
      if(claimed.changes!==1) continue;
      try { hostIntegration.respondApproval(row.approval_id,false); } catch { /* expired host request remains refused */ }
      count++;
    }
    return count;
  }

  return Object.freeze({ handleApprovalEvent, handleCallback, cancelRequest, snapshot });
}

module.exports = Object.freeze({ ApprovalBrokerError, createApprovalBroker });
