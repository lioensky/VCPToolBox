'use strict';

const ACCESS_ERROR_MESSAGE = 'Telegram access policy rejected the update.';
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const COMMAND_PATTERN = /^\/([A-Za-z][A-Za-z0-9_]*)(?:@([A-Za-z0-9_]{1,64}))?(?=\s|$)/;

class AccessPolicyError extends Error {
  constructor(code) {
    super(ACCESS_ERROR_MESSAGE);
    Object.defineProperty(this, 'name', { value: 'AccessPolicyError' });
    this.code = code;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AccessPolicyError);
  }
}

function fail(code) {
  throw new AccessPolicyError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRead(record, key) {
  if (!isRecord(record)) fail('ACCESS_INVALID_UPDATE');
  try {
    return record[key];
  } catch {
    fail('ACCESS_INVALID_UPDATE');
  }
}

function safeOwnKeys(record) {
  if (!isRecord(record)) fail('ACCESS_INVALID_UPDATE');
  try {
    return Object.keys(record);
  } catch {
    fail('ACCESS_INVALID_UPDATE');
  }
}

function normalizeTelegramId(value, options = {}) {
  let signed;
  let allowZero;
  try {
    signed = options.signed === true;
    allowZero = options.allowZero === true;
  } catch {
    fail('ACCESS_INVALID_UPDATE');
  }

  let normalized;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('ACCESS_INVALID_UPDATE');
    normalized = String(value);
  } else if (typeof value === 'string') {
    normalized = value;
  } else {
    fail('ACCESS_INVALID_UPDATE');
  }

  if (allowZero && normalized === '0') return normalized;
  const pattern = signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/;
  if (!pattern.test(normalized)) fail('ACCESS_INVALID_UPDATE');
  return normalized;
}

function normalizeThreadId(value) {
  if (value === undefined) return '0';
  return normalizeTelegramId(value, { signed: false, allowZero: true });
}

function freezeDecision(value) {
  return Object.freeze(value);
}

function snapshotOptions(options) {
  if (!isRecord(options)) fail('ACCESS_CONFIG_INVALID');
  let allowedUserIds;
  let allowedChatIds;
  let groupsEnabled;
  let botUserId;
  let botUsername;
  try {
    allowedUserIds = options.allowedUserIds;
    allowedChatIds = options.allowedChatIds;
    groupsEnabled = options.groupsEnabled;
    botUserId = options.botUserId;
    botUsername = options.botUsername;
  } catch {
    fail('ACCESS_CONFIG_INVALID');
  }
  if (
    !Array.isArray(allowedUserIds)
    || !Array.isArray(allowedChatIds)
    || typeof groupsEnabled !== 'boolean'
    || typeof botUsername !== 'string'
    || !USERNAME_PATTERN.test(botUsername)
  ) {
    fail('ACCESS_CONFIG_INVALID');
  }
  let safeUsers;
  let safeChats;
  let safeBotId;
  try {
    safeUsers = allowedUserIds.map((id) => normalizeTelegramId(id, { signed: false }));
    safeChats = allowedChatIds.map((id) => normalizeTelegramId(id, { signed: true }));
    safeBotId = normalizeTelegramId(botUserId, { signed: false });
  } catch (error) {
    if (error instanceof AccessPolicyError) fail('ACCESS_CONFIG_INVALID');
    fail('ACCESS_CONFIG_INVALID');
  }
  if (safeChats.some((id) => !id.startsWith('-'))) fail('ACCESS_CONFIG_INVALID');
  return Object.freeze({
    allowedUsers: new Set(safeUsers),
    allowedChats: new Set(safeChats),
    groupsEnabled,
    botUserId: safeBotId,
    botUsernameLower: botUsername.toLowerCase(),
  });
}

function readMessageContent(message) {
  const text = safeRead(message, 'text');
  const caption = safeRead(message, 'caption');
  if (text !== undefined && caption !== undefined) fail('ACCESS_INVALID_UPDATE');
  if (text !== undefined && typeof text !== 'string') fail('ACCESS_INVALID_UPDATE');
  if (caption !== undefined && typeof caption !== 'string') fail('ACCESS_INVALID_UPDATE');

  const entities = safeRead(message, 'entities');
  const captionEntities = safeRead(message, 'caption_entities');
  if (text !== undefined && captionEntities !== undefined) fail('ACCESS_INVALID_UPDATE');
  if (caption !== undefined && entities !== undefined) fail('ACCESS_INVALID_UPDATE');
  if (text === undefined && caption === undefined && (entities !== undefined || captionEntities !== undefined)) {
    fail('ACCESS_INVALID_UPDATE');
  }
  return Object.freeze({
    text: text ?? caption ?? '',
    entitiesKey: caption !== undefined ? 'caption_entities' : 'entities',
  });
}

function parseCommand(text, botUsernameLower) {
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return null;
  if (match[2] && match[2].toLowerCase() !== botUsernameLower) return null;
  return Object.freeze({
    name: match[1].toLowerCase(),
    exact: text.slice(match[0].length).trim() === '',
  });
}

function snapshotEntities(message, key) {
  const entities = safeRead(message, key);
  if (entities === undefined) return [];
  if (!Array.isArray(entities) || entities.length > 128) fail('ACCESS_INVALID_UPDATE');
  return entities.map((entity) => {
    if (!isRecord(entity)) fail('ACCESS_INVALID_UPDATE');
    const type = safeRead(entity, 'type');
    const offset = safeRead(entity, 'offset');
    const length = safeRead(entity, 'length');
    if (
      typeof type !== 'string'
      || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(length) || length < 1
    ) {
      fail('ACCESS_INVALID_UPDATE');
    }
    return Object.freeze({ type, offset, length });
  });
}

function hasOwnMention(text, entities, botUsernameLower) {
  for (const entity of entities) {
    if (entity.type !== 'mention') continue;
    if (entity.offset + entity.length > text.length) fail('ACCESS_INVALID_UPDATE');
    if (text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${botUsernameLower}`) {
      return true;
    }
  }
  return false;
}

function isReplyToBot(message, botUserId) {
  const reply = safeRead(message, 'reply_to_message');
  if (reply === undefined) return false;
  if (!isRecord(reply)) fail('ACCESS_INVALID_UPDATE');
  const from = safeRead(reply, 'from');
  if (from === undefined) return false;
  if (!isRecord(from)) fail('ACCESS_INVALID_UPDATE');
  return normalizeTelegramId(safeRead(from, 'id'), { signed: false }) === botUserId;
}

function readMessageIdentity(message) {
  if (!isRecord(message)) fail('ACCESS_INVALID_UPDATE');
  const chat = safeRead(message, 'chat');
  const from = safeRead(message, 'from');
  if (!isRecord(chat) || !isRecord(from)) fail('ACCESS_INVALID_UPDATE');
  const chatType = safeRead(chat, 'type');
  if (typeof chatType !== 'string') fail('ACCESS_INVALID_UPDATE');
  const userId = normalizeTelegramId(safeRead(from, 'id'), { signed: false });
  const threadId = normalizeThreadId(safeRead(message, 'message_thread_id'));
  const chatId = normalizeTelegramId(safeRead(chat, 'id'), {
    signed: chatType === 'group' || chatType === 'supergroup',
  });
  return Object.freeze({ chatId, chatType, threadId, userId });
}

function evaluateMessage(message, config) {
  const identity = readMessageIdentity(message);
  const content = readMessageContent(message);
  const command = parseCommand(content.text, config.botUsernameLower);

  if (identity.chatType === 'private') {
    if (identity.chatId !== identity.userId) {
      return freezeDecision({
        kind: 'message', authorization: 'denied', reason: 'PRIVATE_ID_MISMATCH',
        chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
        trigger: command ? 'command' : 'none',
      });
    }
    if (!config.allowedUsers.has(identity.userId)) {
      const whoami = command?.name === 'whoami' && command.exact;
      return freezeDecision({
        kind: 'message',
        authorization: whoami ? 'whoami' : 'denied',
        reason: whoami ? 'WHOAMI_PRIVATE_BOOTSTRAP' : 'USER_NOT_ALLOWED',
        chatId: identity.chatId,
        threadId: identity.threadId,
        userId: identity.userId,
        trigger: command ? 'command' : 'none',
      });
    }
    return freezeDecision({
      kind: 'message', authorization: 'authorized', reason: 'AUTHORIZED_PRIVATE',
      chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
      trigger: command ? 'command' : 'none',
    });
  }

  if (identity.chatType !== 'group' && identity.chatType !== 'supergroup') {
    return freezeDecision({ kind: 'message', authorization: 'denied', reason: 'CHAT_TYPE_NOT_ALLOWED' });
  }
  if (!config.groupsEnabled) {
    return freezeDecision({
      kind: 'message', authorization: 'denied', reason: 'GROUPS_DISABLED',
      chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
      trigger: command ? 'command' : 'none',
    });
  }
  if (!config.allowedUsers.has(identity.userId)) {
    return freezeDecision({
      kind: 'message', authorization: 'denied', reason: 'USER_NOT_ALLOWED',
      chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
      trigger: command ? 'command' : 'none',
    });
  }
  if (!config.allowedChats.has(identity.chatId)) {
    return freezeDecision({
      kind: 'message', authorization: 'denied', reason: 'CHAT_NOT_ALLOWED',
      chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
      trigger: command ? 'command' : 'none',
    });
  }

  const entities = snapshotEntities(message, content.entitiesKey);
  let trigger = 'none';
  if (command) trigger = 'command';
  else if (hasOwnMention(content.text, entities, config.botUsernameLower)) trigger = 'mention';
  else if (isReplyToBot(message, config.botUserId)) trigger = 'reply';
  if (trigger === 'none') {
    return freezeDecision({
      kind: 'message', authorization: 'denied', reason: 'GROUP_TRIGGER_REQUIRED',
      chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
      trigger,
    });
  }
  return freezeDecision({
    kind: 'message', authorization: 'authorized', reason: 'AUTHORIZED_GROUP',
    chatId: identity.chatId, threadId: identity.threadId, userId: identity.userId,
    trigger,
  });
}

function evaluateNativeStop(stopped, config) {
  if (!isRecord(stopped)) fail('ACCESS_INVALID_UPDATE');
  const chat = safeRead(stopped, 'chat');
  if (!isRecord(chat)) fail('ACCESS_INVALID_UPDATE');
  const chatType = safeRead(chat, 'type');
  if (chatType !== 'private') {
    return freezeDecision({
      kind: 'native_stop', authorization: 'denied', reason: 'PRIVATE_STOP_REQUIRED',
    });
  }
  const chatId = normalizeTelegramId(safeRead(chat, 'id'), { signed: false });
  const threadId = normalizeThreadId(safeRead(stopped, 'message_thread_id'));
  const draftId = normalizeTelegramId(safeRead(stopped, 'draft_id'), { signed: false });
  if (!config.allowedUsers.has(chatId)) {
    return freezeDecision({
      kind: 'native_stop', authorization: 'denied', reason: 'USER_NOT_ALLOWED',
      chatId, threadId, userId: chatId, draftId,
    });
  }
  return freezeDecision({
    kind: 'native_stop', authorization: 'authorized', reason: 'AUTHORIZED_PRIVATE_STOP',
    chatId, threadId, userId: chatId, draftId,
  });
}

function createAccessPolicy(options = {}) {
  const config = snapshotOptions(options);

  function evaluate(update) {
    try {
      const keys = safeOwnKeys(update);
      const recognized = ['message', 'callback_query', 'my_chat_member', 'stopped_message_generation']
        .filter((key) => keys.includes(key));
      if (recognized.length === 0) fail('ACCESS_UNSUPPORTED_UPDATE');
      if (recognized.length !== 1) fail('ACCESS_INVALID_UPDATE');
      const type = recognized[0];
      const payload = safeRead(update, type);
      if (type === 'message') return evaluateMessage(payload, config);
      if (type === 'stopped_message_generation') return evaluateNativeStop(payload, config);
      if (type === 'my_chat_member') {
        return freezeDecision({ kind: 'membership', authorization: 'ignored', reason: 'MEMBERSHIP_ONLY' });
      }
      return freezeDecision({ kind: 'callback', authorization: 'denied', reason: 'CALLBACK_NOT_AVAILABLE' });
    } catch (error) {
      if (error instanceof AccessPolicyError) throw error;
      fail('ACCESS_INVALID_UPDATE');
    }
  }

  return Object.freeze({ evaluate });
}

module.exports = {
  AccessPolicyError,
  createAccessPolicy,
  normalizeTelegramId,
};
