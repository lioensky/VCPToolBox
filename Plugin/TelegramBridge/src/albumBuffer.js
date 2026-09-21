'use strict';
const crypto = require('node:crypto');

function createAlbumBuffer({ database, evaluateAccess, onReady, settleMs = 900, mediaSettleMs = 7500, onError = () => {} }) {
  const pending = new Map();
  // Only retain IDs for admissions that still have a received anchor. The ledger
  // owns request deduplication after admission; a new buffer may replay these IDs.
  const offered = new Set();
  const dispatching = new Set();
  let stopped = false;
  let draining = false;

  function describe(payload) {
    try {
      const message = payload?.message;
      const access = evaluateAccess(payload);
      if (!message || access.authorization !== 'authorized' || access.kind !== 'message') return null;
      const group = message.media_group_id ?? null;
      if (group !== null && (typeof group !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(group))) return null;
      const image = (Array.isArray(message.photo) && message.photo.length > 0)
        || (typeof message.document?.mime_type === 'string' && /^image\//i.test(message.document.mime_type));
      const captioned = typeof message.caption === 'string' && message.caption.trim().length > 0;
      const text = typeof message.text === 'string' && message.text.trim().length > 0
        && !/^\s*\//.test(message.text)
        && !(message.entities ?? []).some(entity => entity.type === 'bot_command')
        && group === null && !['photo', 'document', 'voice', 'audio', 'video', 'video_note',
          'animation', 'sticker', 'contact', 'location', 'venue', 'poll', 'dice', 'paid_media']
          .some(field => message[field] !== undefined);
      return { id: { owner: access.userId, chat: access.chatId, thread: access.threadId, group },
        image, captioned, text, media: group !== null || image };
    } catch { return null; }
  }

  function keyFor(id) {
    return crypto.createHash('sha256').update(JSON.stringify(id)).digest('hex');
  }

  function sameLane(left, right) {
    return left.owner === right.owner && left.chat === right.chat && left.thread === right.thread;
  }

  function decode(row) {
    const payload = JSON.parse(row.payload_json);
    return { ...row, payload, info: describe(payload) };
  }

  function rowsForAlbum(id) {
    return database.prepare(`SELECT *
      FROM updates WHERE CAST(json_extract(payload_json,'$.message.from.id') AS TEXT)=?
      AND CAST(json_extract(payload_json,'$.message.chat.id') AS TEXT)=?
      AND CAST(COALESCE(json_extract(payload_json,'$.message.message_thread_id'),0) AS TEXT)=?
      AND json_extract(payload_json,'$.message.media_group_id')=?
      ORDER BY length(update_id), update_id`).all(id.owner, id.chat, id.thread, id.group)
      .map(decode).filter(row => row.info && sameLane(row.info.id, id) && row.info.id.group === id.group);
  }

  function rowsForBundle(key) {
    return database.prepare(`SELECT * FROM updates WHERE input_bundle_key=?
      ORDER BY length(update_id),update_id`).all(key).map(decode);
  }

  function bundleFor(key) {
    const rows = rowsForBundle(key).filter(row => row.status === 'received'
      && row.album_parent_update_id === null && row.info);
    const anchor = rows.find(row => row.info.media);
    if (!anchor) return null;
    const id = anchor.info.id;
    const media = rows.filter(row => sameLane(row.info.id, id) && row.info.media && row.info.id.group === id.group);
    const texts = rows.filter(row => sameLane(row.info.id, id) && row.info.text);
    return { id, media, texts, openedAt: Math.min(...media.map(row => row.received_at)),
      lastAt: Math.max(...media.map(row => row.received_at)),
      awaitsText: media.every(row => !row.info.captioned) };
  }

  function openKeys() {
    return database.prepare(`SELECT input_bundle_key AS key FROM updates
      WHERE status='received' AND album_parent_update_id IS NULL AND input_bundle_key IS NOT NULL
      GROUP BY input_bundle_key ORDER BY min(received_at),min(length(update_id)),min(update_id)`).all();
  }

  function findCompanionBundle(row, info) {
    const keys = database.prepare(`SELECT input_bundle_key AS key FROM updates
      WHERE status='received' AND album_parent_update_id IS NULL AND input_bundle_key IS NOT NULL
      AND CAST(json_extract(payload_json,'$.message.from.id') AS TEXT)=?
      AND CAST(json_extract(payload_json,'$.message.chat.id') AS TEXT)=?
      AND CAST(COALESCE(json_extract(payload_json,'$.message.message_thread_id'),0) AS TEXT)=?
      GROUP BY input_bundle_key ORDER BY min(received_at) DESC,min(length(update_id)) DESC,min(update_id) DESC`)
      .all(info.id.owner, info.id.chat, info.id.thread);
    for (const { key } of keys) {
      const bundle = bundleFor(key);
      if (!bundle || !sameLane(bundle.id, info.id) || !bundle.awaitsText || bundle.texts.length) continue;
      if (info.media && bundle.id.group !== null) continue;
      if (row.received_at < bundle.openedAt || row.received_at > bundle.openedAt + mediaSettleMs) continue;
      const last = bundle.media[bundle.media.length - 1].update_id;
      if (info.text && (row.update_id.length < last.length
        || (row.update_id.length === last.length && row.update_id <= last))) continue;
      return key;
    }
    return null;
  }

  function bind(row, info) {
    if (row.input_bundle_key) return row.input_bundle_key;
    const attach = database.prepare(`UPDATE updates SET input_bundle_key=?,updated_at=?
      WHERE update_id=? AND status='received' AND album_parent_update_id IS NULL AND input_bundle_key IS NULL`);
    if (info.id.group !== null) {
      const album = rowsForAlbum(info.id);
      if (album.some(member => member.album_parent_update_id !== null || member.status === 'cancelled')) {
        database.prepare(`UPDATE updates SET status='rejected',error_code='ALBUM_LATE_MEMBER',updated_at=?
          WHERE update_id=? AND status='received'`).run(Date.now(), row.update_id);
        return null;
      }
      const key = album.find(member => member.status === 'received' && member.input_bundle_key)?.input_bundle_key
        ?? keyFor(info.id);
      // Telegram batches can already contain the other album members before add
      // sees them. Persist membership together, without rewriting source payloads.
      for (const member of album) attach.run(key, Date.now(), member.update_id);
      return key;
    }
    const companion = findCompanionBundle(row, info);
    if (info.text && !companion) return null;
    const key = companion ?? keyFor({ ...info.id, anchor: row.update_id });
    attach.run(key, Date.now(), row.update_id);
    return key;
  }

  function removePending(key) {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  }

  async function offer(parent) {
    if (stopped || offered.has(parent.update_id)) return;
    offered.add(parent.update_id);
    dispatching.add(parent.update_id);
    try {
      await onReady({ updateId: parent.update_id, payload: JSON.parse(parent.payload_json) });
    } finally {
      dispatching.delete(parent.update_id);
      if (!stopped) {
        for (const updateId of offered) {
          if (database.prepare('SELECT status FROM updates WHERE update_id=?').get(updateId)?.status !== 'received') {
            offered.delete(updateId);
          }
        }
      }
    }
  }

  async function flush(key) {
    if (stopped) return;
    removePending(key);
    let parent;
    database.transaction(() => {
      const bundle = bundleFor(key);
      if (!bundle) return;
      parent = bundle.media[0];
      const members = [...bundle.media.slice(0, 10), ...bundle.texts.slice(0, 1)];
      for (const row of members) database.prepare(`UPDATE updates SET album_parent_update_id=?,
        status=?, updated_at=? WHERE update_id=? AND status='received'`)
        .run(parent.update_id, row === parent ? 'received' : 'album_member', Date.now(), row.update_id);
      for (const row of [...bundle.media.slice(10), ...bundle.texts.slice(1)]) database.prepare(`UPDATE updates SET status='rejected',
        error_code='ALBUM_LIMIT',updated_at=? WHERE update_id=?`).run(Date.now(), row.update_id);
    }).immediate();
    try {
      if (parent) await offer(parent);
    } finally { await drain(); }
  }

  async function activate(key) {
    if (stopped || (!pending.has(key) && pending.size >= 100)) return;
    const bundle = bundleFor(key);
    if (!bundle) { removePending(key); return; }
    const due = bundle.awaitsText ? bundle.openedAt + mediaSettleMs
      : Math.min(bundle.lastAt + settleMs, bundle.openedAt + 3000);
    if (bundle.texts.length || due <= Date.now()) { await flush(key); return; }
    removePending(key);
    const id = bundle.id;
    const timer = setTimeout(() => {
      void flush(key).catch(() => onError('ALBUM_DISPATCH_FAILED', id));
    }, due - Date.now());
    timer.unref?.();
    // Timer state contains only routing metadata, never payloads or media bytes.
    pending.set(key, { id, timer });
  }

  async function drain() {
    if (stopped || draining || pending.size >= 100) return;
    draining = true;
    try {
      for (const { key } of openKeys()) {
        if (stopped || pending.size >= 100) break;
        if (pending.has(key)) continue;
        try { await activate(key); } catch {
          const bundle = bundleFor(key);
          onError('ALBUM_DISPATCH_FAILED', bundle?.id ?? {});
        }
      }
    } finally { draining = false; }
  }

  async function add(item) {
    if (stopped) return false;
    const row = database.prepare('SELECT * FROM updates WHERE update_id=?').get(item.updateId);
    if (!row) return false;
    // The ledger's original, authorized payload is authoritative, including on
    // startup replay; a companion never replaces the photo request anchor.
    const { info } = decode(row);
    if (!info) return false;
    const eligible = info.id.group !== null || (info.image && !info.captioned) || info.text;
    if (!row.input_bundle_key && !row.album_parent_update_id && !eligible) return false;
    if (row.status !== 'received') return true;
    if (row.album_parent_update_id !== null) {
      if (row.album_parent_update_id === row.update_id) await offer(row);
      return true;
    }
    const key = database.transaction(() => bind(row, info)).immediate();
    if (!key) {
      if (info.id.group === null) return false;
      onError('ALBUM_LATE_MEMBER', info.id);
    } else {
      // Overflow membership is already durable, including its following text.
      // A free timer slot or flushLane will admit it without standalone dispatch.
      await activate(key);
    }
    return true;
  }

  async function flushLane(chat, thread) {
    for (const { key } of openKeys()) {
      const bundle = bundleFor(key);
      if (bundle?.id.chat === chat && bundle.id.thread === thread) await flush(key);
    }
  }

  // Caller must authorize /new, /stop (or native stop) before calling this, and
  // call it BEFORE dispatcher.dispatch. Pass access.userId to isolate owners in
  // group chats; omitting it cancels the whole lane. This cancels unadmitted input
  // only; request/queue cancellation remains the dispatcher's responsibility.
  async function cancelLane(chat, thread, ownerUserId) {
    if (stopped) return;
    database.transaction(() => {
      const rows = database.prepare(`SELECT * FROM updates WHERE status IN ('received','album_member')
        AND CAST(json_extract(payload_json,'$.message.chat.id') AS TEXT)=?
        AND CAST(COALESCE(json_extract(payload_json,'$.message.message_thread_id'),0) AS TEXT)=?`)
        .all(chat, thread).map(decode);
      const cancellable = rows.filter(row => {
        if (!row.info || row.info.id.chat !== chat || row.info.id.thread !== thread) return false;
        if (ownerUserId !== undefined && row.info.id.owner !== ownerUserId) return false;
        // acceptBatch persists future messages too. Only cancel input already
        // bound by this buffer (or a legacy sealed parent), not later raw rows.
        if (!row.input_bundle_key && row.album_parent_update_id === null) return false;
        if (row.album_parent_update_id === null) return true;
        const parent = database.prepare('SELECT status FROM updates WHERE update_id=?').get(row.album_parent_update_id);
        return parent?.status === 'received' && !dispatching.has(row.album_parent_update_id);
      });
      for (const row of cancellable) database.prepare(`UPDATE updates SET status='cancelled',
        error_code='INPUT_CANCELLED',updated_at=?,finished_at=? WHERE update_id=?`)
        .run(Date.now(), Date.now(), row.update_id);
    }).immediate();
    for (const [key, group] of pending) {
      if (group.id.chat === chat && group.id.thread === thread
        && (ownerUserId === undefined || group.id.owner === ownerUserId)) removePending(key);
    }
    await drain();
  }

  function messagesFor(updateId) {
    const parent = database.prepare('SELECT * FROM updates WHERE update_id=?').get(updateId);
    if (!parent) return [];
    const id = decode(parent).info?.id;
    if (!id) return [];
    const rows = parent.input_bundle_key ? rowsForBundle(parent.input_bundle_key)
      : database.prepare(`SELECT * FROM updates WHERE album_parent_update_id=?
        ORDER BY length(update_id),update_id`).all(updateId).map(decode);
    return rows.filter(row => row.album_parent_update_id === updateId && row.info && sameLane(row.info.id, id))
      .sort((a, b) => Number(a.info.text) - Number(b.info.text))
      .map(row => row.payload.message);
  }

  function stop() {
    stopped = true;
    for (const group of pending.values()) clearTimeout(group.timer);
    pending.clear();
    offered.clear();
    dispatching.clear();
  }
  return Object.freeze({ add, flushLane, cancelLane, messagesFor, stop });
}
module.exports = { createAlbumBuffer };
