'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAccessPolicy } = require('../src/accessPolicy');
const { createScopeQueue } = require('../src/scopeQueue');
const { createSessionStore } = require('../src/sessionStore');
const { createUpdateDispatcher } = require('../src/updateDispatcher');
const { formatResponseText } = require('../src/responseText');

const OWNER_ID = '900719925474099312345';
const BOT_ID = '777000';

function messageUpdate(text, messageId) {
  const commandToken = /^\/\S+/.exec(text)?.[0];
  return {
    message: {
      message_id: messageId,
      from: { id: OWNER_ID },
      chat: { id: OWNER_ID, type: 'private' },
      text,
      ...(commandToken ? {
        entities: [{ type: 'bot_command', offset: 0, length: commandToken.length }],
      } : {}),
    },
  };
}

function createParityFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-agent-parity-'));
  const pluginRoot = path.join(root, 'TelegramBridge');
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(pluginRoot);
  const store = createSessionStore({
    pluginRoot,
    stateDir,
    defaultAgent: 'ExampleAgent',
    historyMaxMessages: 40,
    historyMaxBytes: 262144,
  });
  store.open();
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ledger = store.createUpdateLedger();
  const conversations = [];
  const responses = [];
  const dispatcher = createUpdateDispatcher({
    accessPolicy: createAccessPolicy({
      allowedUserIds: [OWNER_ID],
      allowedChatIds: [],
      groupsEnabled: false,
      botUserId: BOT_ID,
      botUsername: 'DemoBridgeBot',
    }),
    sessionStore: store,
    scopeQueue: createScopeQueue({
      maxConcurrentScopes: 1,
      maxQueuedTotal: 20,
      maxQueuedPerScope: 20,
    }),
    updateLedger: ledger,
    allowedAgents: ['ExampleAgent', 'SecondAgent'],
    defaultAgent: 'ExampleAgent',
    capabilities: Object.freeze({
      respond: async (payload) => {
        responses.push(payload);
        return { delivered: true };
      },
      prepareAttachments: async () => [],
      conversation: async (context) => {
        const history = store.getHistory(context.scope.key);
        conversations.push({
          agent: context.scope.currentAgent,
          text: context.text,
          history: history.map((item) => ({ role: item.role, content: item.content })),
        });
        store.appendTurn({
          scopeKey: context.scope.key,
          turnId: `turn-${context.requestId}`,
          messages: [
            { role: 'user', content: context.text, telegramMessageId: context.telegramMessageId },
            { role: 'assistant', content: `${context.scope.currentAgent}:${context.text}` },
          ],
        });
        return { accepted: true, completionPersisted: false };
      },
      getActiveStopBinding: () => null,
      stop: async (input) => ({ stopped: false, requestId: input.requestId }),
      retry: async () => ({ accepted: false }),
      tasks: async () => [],
      status: async () => ({ state: 'ready', activeRequests: 0 }),
    }),
    createRequestId: ({ updateId }) => `request-${updateId}`,
    createMessageId: ({ updateId }) => `message-${updateId}`,
  });

  async function send(updateId, text) {
    const update = messageUpdate(text, Number(updateId));
    ledger.acceptBatch([{ updateId, updateType: 'message', payload: update }]);
    const admission = await dispatcher.dispatch({ updateId, update });
    if (admission.completion) await admission.completion;
  }

  return { conversations, responses, send };
}

test('ExampleAgent and SecondAgent keep independent two-turn histories and /new resets only the active Agent', async (t) => {
  const fixture = createParityFixture(t);

  await fixture.send('101', 'ExampleAgent first');
  await fixture.send('102', 'ExampleAgent second');
  await fixture.send('103', '/agent SecondAgent');
  await fixture.send('104', 'SecondAgent first');
  await fixture.send('105', 'SecondAgent second');
  await fixture.send('106', '/agent ExampleAgent');
  await fixture.send('107', 'ExampleAgent resumed');
  await fixture.send('108', '/new');
  await fixture.send('109', 'ExampleAgent fresh');
  await fixture.send('110', '/agent SecondAgent');
  await fixture.send('111', 'SecondAgent resumed');

  assert.deepEqual(fixture.conversations.map((entry) => entry.agent), [
    'ExampleAgent', 'ExampleAgent', 'SecondAgent', 'SecondAgent', 'ExampleAgent', 'ExampleAgent', 'SecondAgent',
  ]);
  assert.deepEqual(fixture.conversations[0].history, []);
  assert.deepEqual(fixture.conversations[1].history.map((item) => item.content), [
    'ExampleAgent first', 'ExampleAgent:ExampleAgent first',
  ]);
  assert.deepEqual(fixture.conversations[2].history, []);
  assert.deepEqual(fixture.conversations[3].history.map((item) => item.content), [
    'SecondAgent first', 'SecondAgent:SecondAgent first',
  ]);
  assert.deepEqual(fixture.conversations[4].history.map((item) => item.content), [
    'ExampleAgent first', 'ExampleAgent:ExampleAgent first', 'ExampleAgent second', 'ExampleAgent:ExampleAgent second',
  ]);
  assert.deepEqual(fixture.conversations[5].history, []);
  assert.deepEqual(fixture.conversations[6].history.map((item) => item.content), [
    'SecondAgent first', 'SecondAgent:SecondAgent first', 'SecondAgent second', 'SecondAgent:SecondAgent second',
  ]);
  assert.equal(JSON.stringify(fixture.conversations).includes('通过 Telegram'), false);
});

test('Telegram help and status text describe channel capabilities without internal identifiers', () => {
  assert.equal(typeof formatResponseText, 'function');
  const help = formatResponseText({ type: 'help' });
  assert.match(help, /photo, document, voice, video and GIF/);
  assert.match(help, /images are sent as media/);
  assert.match(help, /Tools may request approval/);

  const status = formatResponseText({
    type: 'status',
    mode: 'enabled',
    state: 'ready',
    agent: 'SecondAgent',
    vcpReadiness: 'ready',
    pollerState: 'polling',
    activeRequests: 1,
    queuedRequests: 2,
    deadLetters: 3,
    requestId: 'must-not-appear',
  });
  assert.match(status, /Mode: enabled; State: ready; Agent: SecondAgent/);
  assert.match(status, /VCP: ready; Poller: polling/);
  assert.match(status, /Active: 1; Queued: 2; Dead letters: 3/);
  assert.doesNotMatch(status, /must-not-appear/);
});
