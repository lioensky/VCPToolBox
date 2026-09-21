'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AccessPolicyError,
  createAccessPolicy,
  normalizeTelegramId,
} = require('../src/accessPolicy');

const OWNER_ID = '900719925474099312345';
const GROUP_ID = '-100900719925474099312345';
const BOT_ID = '777000';

function policy(overrides = {}) {
  return createAccessPolicy({
    allowedUserIds: [OWNER_ID],
    allowedChatIds: [GROUP_ID],
    groupsEnabled: false,
    botUserId: BOT_ID,
    botUsername: 'DemoBridgeBot',
    ...overrides,
  });
}

function privateMessage({
  userId = OWNER_ID,
  chatId = userId,
  text = 'hello',
  entities,
  threadId,
  extraFrom = {},
} = {}) {
  return {
    message: {
      message_id: 10,
      from: { id: userId, ...extraFrom },
      chat: { id: chatId, type: 'private' },
      text,
      ...(entities ? { entities } : {}),
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    },
  };
}

function groupMessage({
  userId = OWNER_ID,
  chatId = GROUP_ID,
  text = '/status',
  entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  threadId = '71',
  replyToBot = false,
  extraFrom = {},
} = {}) {
  return {
    message: {
      message_id: 11,
      from: { id: userId, ...extraFrom },
      chat: { id: chatId, type: 'supergroup' },
      message_thread_id: threadId,
      text,
      entities,
      ...(replyToBot ? { reply_to_message: { from: { id: BOT_ID, is_bot: true } } } : {}),
    },
  };
}

function assertPolicyError(error, code, fixtures = []) {
  assert.equal(error instanceof AccessPolicyError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const fixture of fixtures) assert.equal(serialized.includes(fixture), false);
  return true;
}

test('normalizes safe numeric and arbitrarily large canonical Telegram IDs as strings', () => {
  assert.equal(normalizeTelegramId(123456789, { signed: false }), '123456789');
  assert.equal(normalizeTelegramId(71, { signed: false, allowZero: true }), '71');
  assert.equal(normalizeTelegramId('900719925474099312345', { signed: false }), OWNER_ID);
  assert.equal(normalizeTelegramId(GROUP_ID, { signed: true }), GROUP_ID);
  assert.equal(normalizeTelegramId(0, { signed: false, allowZero: true }), '0');

  for (const value of [0, -1, '0', '01', '+1', ' 1', 9007199254740992, 1.5, NaN]) {
    assert.throws(
      () => normalizeTelegramId(value, { signed: false }),
      (error) => assertPolicyError(error, 'ACCESS_INVALID_UPDATE'),
    );
  }
  for (const value of ['-0', '-01']) {
    assert.throws(
      () => normalizeTelegramId(value, { signed: true }),
      (error) => assertPolicyError(error, 'ACCESS_INVALID_UPDATE'),
    );
  }
});

test('denies unauthorized private messages but allows only private whoami bootstrap', () => {
  const access = policy();
  const unauthorizedId = '12345678901234567890';
  const denied = access.evaluate(privateMessage({
    userId: unauthorizedId,
    text: 'secret body',
    extraFrom: { username: 'private-user' },
  }));
  const whoami = access.evaluate(privateMessage({
    userId: unauthorizedId,
    text: '/whoami',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
  }));

  assert.deepEqual(denied, {
    kind: 'message',
    authorization: 'denied',
    reason: 'USER_NOT_ALLOWED',
    chatId: unauthorizedId,
    threadId: '0',
    userId: unauthorizedId,
    trigger: 'none',
  });
  assert.deepEqual(whoami, {
    kind: 'message',
    authorization: 'whoami',
    reason: 'WHOAMI_PRIVATE_BOOTSTRAP',
    chatId: unauthorizedId,
    threadId: '0',
    userId: unauthorizedId,
    trigger: 'command',
  });
  assert.equal(Object.isFrozen(denied), true);
  assert.equal(JSON.stringify(denied).includes('secret body'), false);
  assert.equal(JSON.stringify(denied).includes('private-user'), false);
});

test('access decisions never return user-supplied command names or message fragments', () => {
  const secretCommand = 'privatecommandfixture';
  const decision = policy().evaluate(privateMessage({
    userId: '33333333333333333333',
    text: `/${secretCommand}`,
    entities: [{ type: 'bot_command', offset: 0, length: secretCommand.length + 1 }],
  }));

  assert.equal(Object.hasOwn(decision, 'command'), false);
  assert.equal(JSON.stringify(decision).includes(secretCommand), false);
});

test('whoami bootstrap requires the exact no-argument command addressed to this bot', () => {
  const access = policy();
  const withArgument = access.evaluate(privateMessage({
    userId: '22222222222222222222',
    text: '/whoami disclose-more',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }],
  }));
  const otherBot = access.evaluate(privateMessage({
    userId: '22222222222222222222',
    text: '/whoami@OtherBot',
    entities: [{ type: 'bot_command', offset: 0, length: 16 }],
  }));

  assert.equal(withArgument.authorization, 'denied');
  assert.equal(withArgument.reason, 'USER_NOT_ALLOWED');
  assert.equal(otherBot.authorization, 'denied');
  assert.equal(otherBot.reason, 'USER_NOT_ALLOWED');
});

test('denies every group while groups are disabled without administrator elevation', () => {
  const decision = policy().evaluate(groupMessage({ extraFrom: { is_bot: false } }));
  const adminShaped = policy().evaluate({
    message: {
      ...groupMessage().message,
      from: { id: OWNER_ID, is_bot: false, status: 'administrator' },
      sender_chat: { id: GROUP_ID, type: 'channel' },
    },
  });

  assert.equal(decision.authorization, 'denied');
  assert.equal(decision.reason, 'GROUPS_DISABLED');
  assert.equal(adminShaped.authorization, 'denied');
  assert.equal(adminShaped.reason, 'GROUPS_DISABLED');
});

test('group-ready policy requires user and chat allowlists plus command, own mention or reply', () => {
  const access = policy({ groupsEnabled: true });

  const command = access.evaluate(groupMessage());
  const mentionText = 'Demo @DemoBridgeBot please help';
  const mention = access.evaluate(groupMessage({
    text: mentionText,
    entities: [{ type: 'mention', offset: 5, length: 14 }],
    threadId: 900719925474000,
  }));
  const reply = access.evaluate(groupMessage({ text: 'continue', entities: [], replyToBot: true }));
  const silent = access.evaluate(groupMessage({ text: 'ordinary group chatter', entities: [] }));
  const otherBot = access.evaluate(groupMessage({
    text: '/status@OtherBot',
    entities: [{ type: 'bot_command', offset: 0, length: 16 }],
  }));
  const wrongUser = access.evaluate(groupMessage({ userId: '55555' }));
  const wrongChat = access.evaluate(groupMessage({ chatId: '-10099999' }));

  assert.equal(command.authorization, 'authorized');
  assert.equal(command.trigger, 'command');
  assert.equal(Object.hasOwn(command, 'command'), false);
  assert.equal(command.threadId, '71');
  assert.equal(mention.authorization, 'authorized');
  assert.equal(mention.trigger, 'mention');
  assert.equal(mention.threadId, '900719925474000');
  assert.equal(reply.authorization, 'authorized');
  assert.equal(reply.trigger, 'reply');
  assert.equal(silent.reason, 'GROUP_TRIGGER_REQUIRED');
  assert.equal(otherBot.reason, 'GROUP_TRIGGER_REQUIRED');
  assert.equal(wrongUser.reason, 'USER_NOT_ALLOWED');
  assert.equal(wrongChat.reason, 'CHAT_NOT_ALLOWED');
});

test('group media captions support explicit bot mentions without returning caption content', () => {
  const caption = 'photo @DemoBridgeBot context';
  const decision = policy({ groupsEnabled: true }).evaluate({
    message: {
      message_id: 12,
      from: { id: OWNER_ID },
      chat: { id: GROUP_ID, type: 'supergroup' },
      message_thread_id: 73,
      document: { file_id: 'safe-fixture' },
      caption,
      caption_entities: [{ type: 'mention', offset: 6, length: 14 }],
    },
  });

  assert.equal(decision.authorization, 'authorized');
  assert.equal(decision.trigger, 'mention');
  assert.equal(decision.threadId, '73');
  assert.equal(JSON.stringify(decision).includes(caption), false);
});

test('message text and caption are mutually exclusive and fail closed when both exist', () => {
  assert.throws(
    () => policy({ groupsEnabled: true }).evaluate({
      message: {
        message_id: 13,
        from: { id: OWNER_ID },
        chat: { id: GROUP_ID, type: 'supergroup' },
        text: '@DemoBridgeBot text',
        entities: [{ type: 'mention', offset: 0, length: 14 }],
        caption: '@DemoBridgeBot caption',
        caption_entities: [{ type: 'mention', offset: 0, length: 14 }],
      },
    }),
    (error) => assertPolicyError(error, 'ACCESS_INVALID_UPDATE'),
  );
});

test('normalizes native private stop identity and rejects group or invalid draft stop updates', () => {
  const privateStop = policy().evaluate({
    stopped_message_generation: {
      chat: { id: OWNER_ID, type: 'private' },
      message_thread_id: 0,
      draft_id: '900719925474099312346',
    },
  });
  const groupStop = policy({ groupsEnabled: true }).evaluate({
    stopped_message_generation: {
      chat: { id: GROUP_ID, type: 'supergroup' },
      message_thread_id: 71,
      draft_id: 88,
    },
  });

  assert.deepEqual(privateStop, {
    kind: 'native_stop',
    authorization: 'authorized',
    reason: 'AUTHORIZED_PRIVATE_STOP',
    chatId: OWNER_ID,
    threadId: '0',
    userId: OWNER_ID,
    draftId: '900719925474099312346',
  });
  assert.equal(groupStop.authorization, 'denied');
  assert.equal(groupStop.reason, 'PRIVATE_STOP_REQUIRED');
  assert.throws(
    () => policy().evaluate({
      stopped_message_generation: {
        chat: { id: OWNER_ID, type: 'private' },
        draft_id: 0,
      },
    }),
    (error) => assertPolicyError(error, 'ACCESS_INVALID_UPDATE'),
  );
});

test('classifies membership and callbacks without conversation authorization', () => {
  const access = policy();
  assert.deepEqual(access.evaluate({ my_chat_member: { chat: { id: OWNER_ID } } }), {
    kind: 'membership',
    authorization: 'ignored',
    reason: 'MEMBERSHIP_ONLY',
  });
  assert.deepEqual(access.evaluate({ callback_query: { id: 'callback-secret' } }), {
    kind: 'callback',
    authorization: 'denied',
    reason: 'CALLBACK_NOT_AVAILABLE',
  });
});

test('unknown or hostile updates fail with stable content-safe errors', () => {
  const token = '123456:secret-token-fixture';
  const hostile = {};
  Object.defineProperty(hostile, 'message', {
    enumerable: true,
    get() {
      throw new Error(token);
    },
  });

  assert.throws(
    () => policy().evaluate(hostile),
    (error) => assertPolicyError(error, 'ACCESS_INVALID_UPDATE', [token]),
  );
  assert.throws(
    () => policy().evaluate({ edited_message: { text: token } }),
    (error) => assertPolicyError(error, 'ACCESS_UNSUPPORTED_UPDATE', [token]),
  );
});
