'use strict';

function asksForSentImage(text) {
  if(typeof text!=='string')return false;
  return /你(?:刚才|刚刚|刚)?(?:发|画|生成)(?:过|出)?的(?:这|那)?(?:一|几)?(?:张|个|幅)?(?:图片|图|照片|表情)/.test(text)
    || /你(?:刚才|刚刚|刚)(?:发|画|生成).{0,20}(?:图|照片|表情)/.test(text)
    || /你的(?:图片|图|照片|表情)(?:里|中|上)?(?:是|什么|怎么|为何|为什么|呢|看不清)/.test(text)
    || /(?:看|看看|参考|按照|照着|基于)(?:下|一下)?你的(?:图片|图|照片|表情)/.test(text)
    || (/(?:image|picture|photo|drawing|sticker)/i.test(text)&&/you (?:sent|generated|drew)/i.test(text));
}

// A delivered photo is context only for its original Agent conversation.
// Operator proofs and historical conversations do not satisfy the message join.
function findLastSentImage(database, scopeKey) {
  const row = database.prepare(`SELECT d.payload_json, d.source_type FROM deliveries d
    LEFT JOIN async_tasks a ON d.source_type='async_task' AND a.task_key=d.source_key
    JOIN messages m ON m.scope_key=d.scope_key
      AND m.turn_id='turn-'||COALESCE(a.request_id,d.source_key) AND m.role='assistant'
    JOIN scopes s ON s.scope_key=m.scope_key AND s.conversation_id=m.conversation_id
    WHERE d.scope_key=? AND d.status='delivered'
    AND ((d.source_type='telegram_rich_media' AND json_extract(d.payload_json,'$.mediaKind') IN ('photo','animation'))
      OR (d.source_type='async_task' AND d.kind='async_media' AND
        json_extract(d.payload_json,'$.media.mediaKind') IN ('photo','animation')))
    ORDER BY d.delivered_at DESC, d.idempotency_key DESC LIMIT 1`).get(scopeKey);
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  if (row.source_type === 'telegram_rich_media') return payload;
  return payload.media ?? null;
}

module.exports = Object.freeze({ findLastSentImage, asksForSentImage });
