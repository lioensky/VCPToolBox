'use strict';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE = /^telegram:-?[1-9]\d*:(?:0|[1-9]\d*):[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const TERMINAL_WITHOUT_ANSWER = new Set(['needs_review', 'retryable_failed', 'failed', 'cancelled']);

function fail(code) {
  const error = new Error('Telegram conversation history operation failed.');
  error.code = code;
  throw error;
}

function inputText(messages) {
  const text = messages.map(m => m.caption || m.text || '').filter(Boolean).join('\n');
  if (text) return text;
  return messages.length > 1 ? `[相册：${messages.length} 项附件]` : '[收到附件]';
}

function requestState(row) {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.error_code === 'INTERRUPTED_EFFECT_UNKNOWN') return 'interrupted';
  if (row.effect_state === 'not_started') return 'failed';
  return 'unconfirmed';
}

function createConversationHistory(database, options = {}) {
  const maxMessages = options.historyMaxMessages ?? 40;
  const maxBytes = options.historyMaxBytes ?? 262144;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 2 || maxMessages > 200
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) fail('HISTORY_CONFIG_INVALID');

  function identity(input, requireRequest = false) {
    if (!input || typeof input !== 'object' || !SCOPE.test(input.scopeKey)
        || typeof input.conversationId !== 'string' || !ID.test(input.conversationId)
        || typeof input.ownerUserId !== 'string' || !/^[1-9]\d{0,127}$/.test(input.ownerUserId)
        || ((requireRequest || input.requestId !== undefined)
          && (typeof input.requestId !== 'string' || !ID.test(input.requestId)))) fail('HISTORY_INPUT_INVALID');
    const scope = database.prepare('SELECT * FROM scopes WHERE scope_key=?').get(input.scopeKey);
    if (!scope || scope.conversation_id !== input.conversationId || !scope.is_active) fail('HISTORY_SCOPE_INVALID');
    if (input.requestId !== undefined) {
      const request = database.prepare('SELECT * FROM requests WHERE request_id=?').get(input.requestId);
      if (!request || request.scope_key !== input.scopeKey || request.owner_user_id !== input.ownerUserId) {
        fail('HISTORY_REQUEST_INVALID');
      }
      return { scope, request };
    }
    return { scope, request: null };
  }

  function rememberInput(input) {
    return database.transaction(() => {
      const { request } = identity(input, true);
      if (typeof input.userText !== 'string' || input.userText.length === 0
          || Buffer.byteLength(input.userText) > 1048576
          || typeof input.telegramMessageId !== 'string' || !/^[1-9]\d{0,127}$/.test(input.telegramMessageId)) {
        fail('HISTORY_INPUT_INVALID');
      }
      const old = database.prepare('SELECT * FROM conversation_inputs WHERE request_id=?').get(input.requestId);
      if (old) {
        if (old.scope_key !== input.scopeKey || old.conversation_id !== input.conversationId
            || old.owner_user_id !== input.ownerUserId || old.user_text !== input.userText
            || old.telegram_message_id !== input.telegramMessageId) fail('HISTORY_INPUT_COLLISION');
        return { changed: false };
      }
      if (request.status !== 'processing') fail('HISTORY_REQUEST_INVALID');
      database.prepare(`INSERT INTO conversation_inputs(request_id,scope_key,conversation_id,
        owner_user_id,telegram_message_id,user_text,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(input.requestId, input.scopeKey, input.conversationId, input.ownerUserId,
          input.telegramMessageId, input.userText, request.started_at);
      return { changed: true };
    }).immediate();
  }

  function legacyText(row, input) {
    const payloads = database.prepare(`SELECT update_id,payload_json FROM updates
      WHERE update_id=? OR album_parent_update_id=? ORDER BY length(update_id),update_id LIMIT 11`)
      .all(row.update_id, row.update_id);
    const messages = [];
    for (const payload of payloads) {
      let message;
      try { message = JSON.parse(payload.payload_json)?.message; } catch { return null; }
      if (!message || String(message.from?.id) !== input.ownerUserId
          || /^\s*\/\S+/.test(message.text || message.caption || '')) return null;
      messages.push(message);
    }
    return messages.length ? inputText(messages) : null;
  }

  function getHistory(input) {
    const { scope, request: current } = identity(input);
    const upper = current?.started_at ?? Number.MAX_SAFE_INTEGER;
    const units = new Map();
    let anchor = Number.MAX_SAFE_INTEGER;
    const stored = database.prepare(`SELECT m.*,r.request_id AS origin_request_id,r.owner_user_id,
        r.update_id,r.started_at AS request_started_at
      FROM messages m LEFT JOIN requests r ON m.turn_id='turn-'||r.request_id
      WHERE m.scope_key=? AND m.conversation_id=?
      ORDER BY m.turn_seq DESC,m.position DESC LIMIT ?`)
      .all(input.scopeKey, input.conversationId, maxMessages * 2).reverse();
    for (const row of stored) {
      if (!['user', 'assistant'].includes(row.role) || row.origin_request_id === input.requestId
          || (row.origin_request_id ? row.owner_user_id !== input.ownerUserId : scope.chat_id !== input.ownerUserId)
          || (row.request_started_at ?? row.created_at) > upper) continue;
      if (row.origin_request_id) anchor = Math.min(anchor, row.request_started_at);
      const key = row.update_id ? `update:${row.update_id}` : `turn:${row.turn_id}`;
      let unit = units.get(key);
      // Explicit manual retries share a human update. Prefer the most recent completed turn.
      if (!unit || (row.request_started_at ?? row.created_at) > unit.version) {
        unit = { at: unit?.at ?? row.request_started_at ?? row.created_at,
          version: row.request_started_at ?? row.created_at, key, entries: [] };
        units.set(key, unit);
      }
      if ((row.request_started_at ?? row.created_at) !== unit.version) continue;
      const parsed = JSON.parse(row.content_json);
      unit.entries.push({ role: row.role, content: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
        ...(row.origin_request_id ? { requestId: row.origin_request_id } : {}) });
    }

    const pending = database.prepare(`SELECT i.*,r.status,r.error_code,r.effect_state,r.update_id,
        r.started_at FROM conversation_inputs i JOIN requests r ON r.request_id=i.request_id
      WHERE i.scope_key=? AND i.conversation_id=? AND i.owner_user_id=?
        AND r.scope_key=i.scope_key AND r.owner_user_id=i.owner_user_id AND r.started_at<=?
      ORDER BY i.created_at DESC,length(r.update_id) DESC,r.update_id DESC,r.rowid DESC LIMIT ?`)
      .all(input.scopeKey, input.conversationId, input.ownerUserId, upper, maxMessages * 2);
    const known = new Set(pending.map(row => row.request_id));
    // Older releases did not journal inputs. Infer only after a retained, owner-bound
    // successful turn in THIS conversation. An empty/new conversation has no anchor.
    if (anchor !== Number.MAX_SAFE_INTEGER) {
      const legacy = database.prepare(`SELECT r.* FROM requests r
        WHERE r.scope_key=? AND r.owner_user_id=? AND r.started_at>? AND r.started_at<=?
          AND r.status IN ('needs_review','retryable_failed','failed','cancelled')
          AND NOT EXISTS(SELECT 1 FROM conversation_inputs i WHERE i.request_id=r.request_id)
        ORDER BY r.started_at DESC,length(r.update_id) DESC,r.update_id DESC,r.rowid DESC LIMIT ?`)
        .all(input.scopeKey, input.ownerUserId, anchor, upper, maxMessages * 2);
      for (const row of legacy) {
        if (known.has(row.request_id)) continue;
        const userText = legacyText(row, input);
        if (userText) pending.push({ ...row, user_text: userText, created_at: row.started_at });
      }
    }
    for (const row of pending) {
      if (row.request_id === input.requestId || !TERMINAL_WITHOUT_ANSWER.has(row.status)) continue;
      if(row.update_id&&database.prepare(`SELECT 1 FROM requests WHERE update_id=? AND scope_key=?
        AND owner_user_id=? AND status='completed' AND started_at>=? LIMIT 1`)
        .get(row.update_id,input.scopeKey,input.ownerUserId,row.started_at))continue;
      const key = row.update_id ? `update:${row.update_id}` : `request:${row.request_id}`;
      const prior = units.get(key);
      // A canonical completed answer wins over the earlier failed attempt; an explicit
      // later retry can instead carry its own unconfirmed state without duplicating input.
      if (prior && prior.version >= row.started_at) continue;
      units.set(key, { at: Math.min(prior?.at ?? row.created_at, row.created_at), version: row.started_at, key,
        entries: [{ role: 'user', content: row.user_text, requestId: row.request_id, requestState: requestState(row) }] });
    }
    if (current?.update_id) units.delete(`update:${current.update_id}`);
    // Normalize the output view BEFORE budgeting: spaced selectors can be larger
    // than the immutable raw records and must not poison the next valid request.
    const ordered = [...units.values()].map(unit=>({...unit,entries:unit.entries.map(entry=>({...entry,
      content:entry.content.replace(/\{\{(?=\s*agent\s*:)/gi,'{ {'),
    }))})).sort((a, b) => {
      if(a.at!==b.at)return a.at-b.at;
      if(a.key.startsWith('update:')&&b.key.startsWith('update:')) {
        const left=a.key.slice(7),right=b.key.slice(7);
        return left.length-right.length||(left===right?0:left<right?-1:1);
      }
      return a.key.localeCompare(b.key);
    });
    let count = 1;
    let bytes = Buffer.byteLength(JSON.stringify({ role: 'user', content: input.userText ?? '' }));
    const kept = [];
    for (let index = ordered.length - 1; index >= 0; index--) {
      const unit = ordered[index];
      const size = unit.entries.reduce((n, { role, content, requestState: state }) =>
        n + Buffer.byteLength(JSON.stringify({ role, content })) + (state ? 1024 : 0)
          + (role === 'user' ? 300 : 0), 0);
      if (count + unit.entries.length > maxMessages || bytes + size > maxBytes) break;
      count += unit.entries.length;
      bytes += size;
      kept.unshift(unit.entries);
    }
    return kept.flat();
  }

  return Object.freeze({ rememberInput, getHistory });
}

module.exports = Object.freeze({ createConversationHistory, inputText });
