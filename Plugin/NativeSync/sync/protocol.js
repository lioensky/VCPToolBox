'use strict';
const crypto = require('node:crypto');
const { canonicalizeMessage, BoundedWarnings, messageContentHash } = require('./canonical/canonical');
const { stableStringify } = require('./canonical/hash');

function identity(value) {
    if (!value || !['agent', 'group'].includes(value.ownerType)) throw new Error('INVALID_IDENTITY');
    for (const field of ['ownerId', 'topicId']) {
        const v = value[field];
        if (typeof v !== 'string' || !v || /[<>:"/\\|?*\x00-\x1f]/.test(v) || v === '.' || v === '..' || /[. ]$/.test(v) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)) throw new Error('INVALID_IDENTITY');
    }
    if (typeof value.msgId !== 'string' || !value.msgId) throw new Error('INVALID_IDENTITY');
    return { ownerType: value.ownerType, ownerId: value.ownerId, topicId: value.topicId, msgId: value.msgId };
}
function canonicalMessage(value, topicId = '_') {
    const warnings = new BoundedWarnings();
    const message = canonicalizeMessage(value, topicId, warnings);
    if (warnings.count) throw new Error('INVALID_ATTACHMENT');
    return message;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const messageKey = value => { const v = identity(value); return JSON.stringify([v.ownerType, v.ownerId, v.topicId, v.msgId]); };
const messageHash = message => messageContentHash(canonicalMessage(message, message.topicId || '_'));
const tombstoneHash = id => sha256(`deleted:${messageKey(id)}`);
const descriptor = id => ({ itemId: id.ownerId, itemType: id.ownerType, topicId: id.topicId });
const wireTopic = d => ({ ownerId: d.itemId, ownerType: d.itemType || 'agent', topicId: d.topicId });
const fail = code => Object.assign(new Error(code), { code });
module.exports = { identity, canonicalMessage, sha256, stable: stableStringify, messageKey, messageHash, tombstoneHash, descriptor, wireTopic, fail };
