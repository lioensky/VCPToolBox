'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createAccessPolicy } = require('../src/accessPolicy');
const { createScopeQueue } = require('../src/scopeQueue');
const { createSessionStore } = require('../src/sessionStore');
const { DispatcherError, createUpdateDispatcher } = require('../src/updateDispatcher');

const OWNER_ID = '900719925474099312345';
const OTHER_ID = '12345678901234567890';
const GROUP_ID = '-100900719925474099312345';
const BOT_ID = '777000';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function messageUpdate(text, {
  userId = OWNER_ID,
  chatId = userId,
  chatType = 'private',
  threadId,
  messageId = 10,
  document,
  caption,
  captionEntities,
  replyToBot = false,
} = {}) {
  const commandToken = typeof text === 'string' ? /^\/\S+/.exec(text)?.[0] : null;
  return {
    message: {
      message_id: messageId,
      from: { id: userId },
      chat: { id: chatId, type: chatType },
      ...(text === undefined ? {} : { text }),
      ...(commandToken ? {
        entities: [{ type: 'bot_command', offset: 0, length: commandToken.length }],
      } : {}),
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
      ...(document ? { document } : {}),
      ...(caption === undefined ? {} : { caption }),
      ...(captionEntities === undefined ? {} : { caption_entities: captionEntities }),
      ...(replyToBot ? { reply_to_message: { from: { id: BOT_ID, is_bot: true } } } : {}),
    },
  };
}

function createFakeSession(options = {}) {
  const active = new Map();
  const scopes = new Map();
  const calls = {
    getOrCreateScope: [],
    getActiveScope: [],
    switchAgent: [],
    startNewConversation: [],
  };
  let conversation = 0;

  function laneKey(chatId, threadId) {
    return `${chatId}:${threadId}`;
  }

  function scopeFor(chatId, threadId, agent, isActive = true) {
    return Object.freeze({
      key: `telegram:${chatId}:${threadId}:${agent}`,
      chatId,
      threadId,
      currentAgent: agent,
      conversationId: `conversation-${++conversation}`,
      isActive,
    });
  }

  function scopeKey(chatId, threadId, agent) {
    return `telegram:${chatId}:${threadId}:${agent}`;
  }

  function createAndStore(chatId, threadId, agent, isActive) {
    const scope = scopeFor(chatId, threadId, agent, isActive);
    scopes.set(scope.key, scope);
    return scope;
  }

  const api = {
    getOrCreateScope(input) {
      calls.getOrCreateScope.push({ ...input });
      if (options.getOrCreateScope) return options.getOrCreateScope(input);
      const threadId = input.threadId ?? '0';
      const key = laneKey(input.chatId, threadId);
      if (input.agent !== undefined) {
        const exactKey = scopeKey(input.chatId, threadId, input.agent);
        let exact = scopes.get(exactKey);
        if (!exact) {
          exact = createAndStore(input.chatId, threadId, input.agent, !active.has(key));
          if (!active.has(key)) active.set(key, exact);
        }
        return exact;
      }
      let scope = active.get(key);
      if (!scope) {
        scope = createAndStore(input.chatId, threadId, 'ExampleAgent', true);
        active.set(key, scope);
      }
      return scope;
    },
    getActiveScope(input) {
      calls.getActiveScope.push({ ...input });
      return active.get(laneKey(input.chatId, input.threadId ?? '0'));
    },
    switchAgent(scopeKey, agent) {
      calls.switchAgent.push({ scopeKey, agent });
      if (options.switchAgentFailureAgent === agent) {
        throw new Error('stable switch failure fixture');
      }
      const source = scopes.get(scopeKey);
      if (!source) throw new Error('missing fake scope');
      const next = createAndStore(source.chatId, source.threadId, agent, true);
      active.set(laneKey(source.chatId, source.threadId), next);
      return next;
    },
    startNewConversation(scopeKey) {
      calls.startNewConversation.push(scopeKey);
      const source = scopes.get(scopeKey);
      if (!source) throw new Error('missing fake scope');
      const next = createAndStore(source.chatId, source.threadId, source.currentAgent, true);
      active.set(laneKey(source.chatId, source.threadId), next);
      return next;
    },
  };
  function seedActive(chatId, threadId, agent) {
    const scope = createAndStore(chatId, threadId, agent, true);
    active.set(laneKey(chatId, threadId), scope);
    return scope;
  }
  return { api: Object.freeze(api), calls, active, scopes, seedActive };
}

function fixture(overrides = {}) {
  const groupsEnabled = overrides.groupsEnabled ?? false;
  const allowedAgents = overrides.allowedAgents ?? ['ExampleAgent', 'Yuzu'];
  const accessPolicy = overrides.accessPolicy ?? createAccessPolicy({
    allowedUserIds: [OWNER_ID],
    allowedChatIds: [GROUP_ID],
    groupsEnabled,
    botUserId: BOT_ID,
    botUsername: 'DemoBridgeBot',
  });
  const session = createFakeSession({
    switchAgentFailureAgent: overrides.switchAgentFailureAgent,
    getOrCreateScope: overrides.getOrCreateScope,
  });
  if (overrides.activeAgent) session.seedActive(OWNER_ID, '0', overrides.activeAgent);
  const queue = overrides.scopeQueue ?? createScopeQueue({
    maxConcurrentScopes: overrides.maxConcurrentScopes ?? 2,
    maxQueuedTotal: 30,
    maxQueuedPerScope: 20,
  });
  const calls = {
    reject: [],
    authorize: [],
    respond: [],
    prepareAttachments: [],
    conversation: [],
    stopBinding: [],
    stop: [],
    retry: [],
    tasks: [],
    status: [],
    lifecycle: [],
    getRequest: [],
    order: [],
  };
  const requestRecords = new Map(Object.entries(overrides.requestRecords ?? {}));
  const rejectedUpdates = new Map();
  const ledger = Object.freeze({
    rejectUpdate(updateId, errorCode) {
      calls.reject.push({ updateId, errorCode });
      if (rejectedUpdates.has(updateId)) {
        return { changed: false, currentStatus: 'rejected' };
      }
      rejectedUpdates.set(updateId, errorCode);
      return { changed: true };
    },
    authorizeAndQueue(updateId, input) {
      calls.authorize.push({ updateId, ...input });
      calls.order.push(`authorize:${input.requestId}`);
      if (overrides.authorizeAndQueue) return overrides.authorizeAndQueue(updateId, input);
      const existing = requestRecords.get(input.requestId);
      if (existing) return { changed: false, currentStatus: existing.status };
      const request = {
        requestId: input.requestId,
        messageId: input.messageId,
        updateId,
        scopeKey: input.scopeKey,
        orderingKey: input.orderingKey,
        ownerUserId: input.ownerUserId,
        status: 'queued',
        effectState: 'not_started',
        replayPolicy: input.replayPolicy,
      };
      requestRecords.set(input.requestId, request);
      return { changed: true, request: { ...request } };
    },
    getRequest(requestId) {
      calls.getRequest.push(requestId);
      const request = requestRecords.get(requestId);
      return request ? { ...request } : null;
    },
    claimRequest(requestId, workerId) {
      calls.lifecycle.push(['claim', requestId, workerId]);
      const request = requestRecords.get(requestId);
      if (!request || request.status !== 'queued') return { changed: false, currentStatus: request?.status ?? null };
      request.status = 'processing';
      return { changed: true, request: { ...request } };
    },
    markEffectStarted(requestId) {
      calls.lifecycle.push(['effect_started', requestId]);
      const request = requestRecords.get(requestId);
      if (!request || request.status !== 'processing') return { changed: false, currentStatus: request?.status ?? null };
      if (overrides.markEffectStarted) {
        return overrides.markEffectStarted(requestId, request);
      }
      request.effectState = 'started';
      return { changed: true, request: { ...request } };
    },
    markEffectUnknown(requestId) {
      calls.lifecycle.push(['effect_unknown', requestId]);
      const request = requestRecords.get(requestId);
      if (request) request.effectState = 'unknown';
      return { changed: Boolean(request), request: request ? { ...request } : null };
    },
    completeRequest(requestId) {
      calls.lifecycle.push(['complete', requestId]);
      const request = requestRecords.get(requestId);
      if (!request) return { changed: false, currentStatus: null };
      if (overrides.completeRequest) {
        return overrides.completeRequest(requestId, request);
      }
      request.status = 'completed';
      request.effectState = 'confirmed';
      return { changed: true, request: { ...request } };
    },
    failBeforeEffect(requestId, errorCode) {
      calls.lifecycle.push(['failed_before_effect', requestId, errorCode]);
      const request = requestRecords.get(requestId);
      if (!request) return { changed: false, currentStatus: null };
      request.status = 'retryable_failed';
      request.errorCode = errorCode;
      return { changed: true, request: { ...request } };
    },
    markNeedsReview(requestId, errorCode) {
      calls.lifecycle.push(['needs_review', requestId, errorCode]);
      const request = requestRecords.get(requestId);
      if (!request) return { changed: false, currentStatus: null };
      request.status = 'needs_review';
      request.errorCode = errorCode;
      return { changed: true, request: { ...request } };
    },
  });
  let activeStopBinding = overrides.activeStopBinding ?? null;
  const capabilities = {
    async respond(input) {
      calls.respond.push(input);
      if (overrides.respond) return overrides.respond(input);
      return { delivered: true };
    },
    async prepareAttachments(input) {
      calls.prepareAttachments.push(input);
      if (overrides.prepareAttachments) return overrides.prepareAttachments(input);
      return Object.freeze([]);
    },
    async conversation(input) {
      calls.conversation.push(input);
      if (overrides.conversation) return overrides.conversation(input);
      return { accepted: true };
    },
    getActiveStopBinding(input) {
      calls.stopBinding.push(input);
      if (overrides.getActiveStopBinding) return overrides.getActiveStopBinding(input);
      return activeStopBinding;
    },
    async stop(input) {
      calls.stop.push(input);
      if (overrides.stop) return overrides.stop(input);
      return { stopped: true, requestId: input.requestId };
    },
    async retry(input) {
      calls.retry.push(input);
      if (overrides.retry) return overrides.retry(input);
      return { accepted: true, requestId: `retry-${input.targetRequestId}` };
    },
    async tasks(input) {
      calls.tasks.push(input);
      if (overrides.tasks) return overrides.tasks(input);
      return [];
    },
    async status(input) {
      calls.status.push(input);
      if (overrides.status) return overrides.status(input);
      return { state: 'ready', activeRequests: 0 };
    },
  };
  const dispatcher = createUpdateDispatcher({
    accessPolicy,
    sessionStore: overrides.sessionStore ?? session.api,
    scopeQueue: queue,
    updateLedger: overrides.updateLedger ?? ledger,
    allowedAgents,
    defaultAgent: 'ExampleAgent',
    capabilities,
    createRequestId: overrides.createRequestId ?? (({ updateId }) => `request-${updateId}`),
    createMessageId: overrides.createMessageId ?? (({ updateId }) => `message-${updateId}`),
  });
  return {
    dispatcher,
    calls,
    session,
    queue,
    requestRecords,
    rejectedUpdates,
    ledger,
    setActiveStopBinding(value) { activeStopBinding = value; },
  };
}

function realConversationFixture(t, { updateId, conversation }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-dispatch-conversation-'));
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
  const update = messageUpdate('real conversation terminal');
  ledger.acceptBatch([{ updateId, updateType: 'message', payload: update }]);
  const dispatcher = createUpdateDispatcher({
    accessPolicy: createAccessPolicy({
      allowedUserIds: [OWNER_ID],
      allowedChatIds: [GROUP_ID],
      groupsEnabled: false,
      botUserId: BOT_ID,
      botUsername: 'DemoBridgeBot',
    }),
    sessionStore: store,
    scopeQueue: createScopeQueue({
      maxConcurrentScopes: 1,
      maxQueuedTotal: 10,
      maxQueuedPerScope: 5,
    }),
    updateLedger: ledger,
    allowedAgents: ['ExampleAgent'],
    defaultAgent: 'ExampleAgent',
    capabilities: Object.freeze({
      respond: async () => ({ delivered: true }),
      prepareAttachments: async () => [],
      conversation,
      getActiveStopBinding: () => null,
      stop: async (input) => ({ stopped: true, requestId: input.requestId }),
      retry: async () => ({ accepted: false }),
      tasks: async () => [],
      status: async () => ({ state: 'ready', activeRequests: 0 }),
    }),
    createRequestId: () => `request-${updateId}`,
    createMessageId: () => `message-${updateId}`,
  });
  return { dispatcher, ledger, update };
}

function realImmediateFixture(t, { updateId, update }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-dispatch-immediate-'));
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
  const updateType = Object.keys(update)[0];
  ledger.acceptBatch([{ updateId, updateType, payload: update }]);
  const calls = { respond: [] };
  const dispatcher = createUpdateDispatcher({
    accessPolicy: createAccessPolicy({
      allowedUserIds: [OWNER_ID],
      allowedChatIds: [GROUP_ID],
      groupsEnabled: false,
      botUserId: BOT_ID,
      botUsername: 'DemoBridgeBot',
    }),
    sessionStore: store,
    scopeQueue: createScopeQueue({
      maxConcurrentScopes: 1,
      maxQueuedTotal: 10,
      maxQueuedPerScope: 5,
    }),
    updateLedger: ledger,
    allowedAgents: ['ExampleAgent'],
    defaultAgent: 'ExampleAgent',
    capabilities: Object.freeze({
      respond: async (input) => {
        calls.respond.push(input);
        return { delivered: true };
      },
      prepareAttachments: async () => [],
      conversation: async () => ({ accepted: true }),
      getActiveStopBinding: () => null,
      stop: async (input) => ({ stopped: true, requestId: input.requestId }),
      retry: async () => ({ accepted: false }),
      tasks: async () => [],
      status: async () => ({ state: 'ready', activeRequests: 0 }),
    }),
    createRequestId: () => `request-${updateId}`,
    createMessageId: () => `message-${updateId}`,
  });
  return { calls, dispatcher, ledger };
}

async function settle(dispatcher, updateId, update) {
  const admission = await dispatcher.dispatch({ updateId, update });
  if (admission.completion) return { admission, completion: await admission.completion };
  return { admission, completion: null };
}

function assertDispatcherError(error, code, fixtures = []) {
  assert.equal(error instanceof DispatcherError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  const serialized = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const fixture of fixtures) assert.equal(serialized.includes(fixture), false);
  return true;
}

async function runSyncDependencyContractScenarios() {
  const secret = 'sync-contract-secret';
  function hostileThenable(label) {
    const value = {};
    Object.defineProperty(value, 'then', {
      enumerable: true,
      get() { throw new Error(`${secret}-${label}`); },
    });
    return value;
  }
  const hostileDecision = {};
  Object.defineProperty(hostileDecision, 'authorization', {
    enumerable: true,
    get() { throw new Error(secret); },
  });
  const scenarios = [
    {
      name: 'async_access',
      code: 'DISPATCH_INVALID_UPDATE',
      options: {
        accessPolicy: Object.freeze({
          evaluate: () => Promise.reject(new Error(secret)),
        }),
      },
    },
    {
      name: 'hostile_decision',
      code: 'DISPATCH_INVALID_UPDATE',
      options: { accessPolicy: Object.freeze({ evaluate: () => hostileDecision }) },
    },
    {
      name: 'invalid_decision_enum',
      code: 'DISPATCH_INVALID_UPDATE',
      options: {
        accessPolicy: Object.freeze({
          evaluate: () => ({
            kind: 'callback', authorization: 'denied', reason: 'CALLBACK_NOT_AVAILABLE',
            trigger: 'user-controlled-trigger',
          }),
        }),
      },
    },
    {
      name: 'async_request_id',
      code: 'DISPATCH_ID_INVALID',
      options: { createRequestId: () => Promise.reject(new Error(secret)) },
    },
    {
      name: 'async_message_id',
      code: 'DISPATCH_ID_INVALID',
      options: { createMessageId: () => Promise.reject(new Error(secret)) },
    },
    {
      name: 'async_session',
      code: 'DISPATCH_SESSION_FAILED',
      options: { getOrCreateScope: () => Promise.reject(new Error(secret)) },
    },
    {
      name: 'hostile_session_then',
      code: 'DISPATCH_SESSION_FAILED',
      options: { getOrCreateScope: () => hostileThenable('session') },
    },
    {
      name: 'async_ledger',
      code: 'DISPATCH_LEDGER_FAILED',
      options: { authorizeAndQueue: () => Promise.reject(new Error(secret)) },
    },
    {
      name: 'hostile_ledger_then',
      code: 'DISPATCH_LEDGER_FAILED',
      options: { authorizeAndQueue: () => hostileThenable('ledger') },
    },
    {
      name: 'async_queue_admission',
      code: 'DISPATCH_QUEUE_FAILED',
      options: {
        scopeQueue: Object.freeze({
          enqueue: () => Promise.reject(new Error(secret)),
        }),
      },
    },
    {
      name: 'hostile_queue_then',
      code: 'DISPATCH_QUEUE_FAILED',
      options: {
        scopeQueue: Object.freeze({
          enqueue: () => hostileThenable('queue'),
        }),
      },
    },
  ];

  let updateId = 100;
  for (const scenario of scenarios) {
    const { dispatcher } = fixture(scenario.options);
    await assert.rejects(
      dispatcher.dispatch({ updateId: String(updateId++), update: messageUpdate(scenario.name) }),
      (error) => assertDispatcherError(error, scenario.code, [secret]),
      scenario.name,
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('sync dependency contract scenarios drain rejected thenables safely', async () => {
  await runSyncDependencyContractScenarios();
});

test('strict child process survives rejected synchronous dependency thenables', () => {
  const modulePath = path.resolve(__dirname, '..', 'src', 'updateDispatcher.js');
  const script = `
    'use strict';
    const assert = require('node:assert/strict');
    const { createUpdateDispatcher, DispatcherError } = require(${JSON.stringify(modulePath)});
    const secret = 'sync-contract-secret';
    const owner = '900719925474099312345';
    const update = { message: { message_id: 1, from: { id: owner }, chat: { id: owner, type: 'private' }, text: 'hello' } };
    const decision = Object.freeze({ kind: 'message', authorization: 'authorized', reason: 'AUTHORIZED_PRIVATE', chatId: owner, threadId: '0', userId: owner, trigger: 'none' });
    function hostileThenable(label) {
      const value = {};
      Object.defineProperty(value, 'then', { get() { throw new Error(secret + '-' + label); } });
      return value;
    }
    function activeThenable() {
      return {
        then() {
          process.stdout.write('CUSTOM_THENABLE_SIDE_EFFECT');
          return {
            catch() {
              Promise.reject(new Error('SECONDARY_UNHANDLED'));
            },
          };
        },
      };
    }
    function build(overrides = {}) {
      const sessionStore = {
        getOrCreateScope: () => ({ key: 'telegram:' + owner + ':0:ExampleAgent', chatId: owner, threadId: '0', currentAgent: 'ExampleAgent', conversationId: 'conversation', isActive: true }),
        getActiveScope: () => ({ key: 'telegram:' + owner + ':0:ExampleAgent', chatId: owner, threadId: '0', currentAgent: 'ExampleAgent', conversationId: 'conversation', isActive: true }),
        switchAgent: () => { throw new Error('unused'); },
        startNewConversation: () => { throw new Error('unused'); },
        ...overrides.sessionStore,
      };
      const updateLedger = {
        rejectUpdate: () => ({ changed: true }),
        authorizeAndQueue: () => ({ changed: true }),
        getRequest: () => null,
        claimRequest: () => ({ changed: true }),
        markEffectStarted: () => ({ changed: true }),
        markEffectUnknown: () => ({ changed: true }),
        completeRequest: () => ({ changed: true }),
        failBeforeEffect: () => ({ changed: true }),
        markNeedsReview: () => ({ changed: true }),
        ...overrides.updateLedger,
      };
      return createUpdateDispatcher({
        accessPolicy: overrides.accessPolicy || { evaluate: () => decision },
        sessionStore,
        scopeQueue: overrides.scopeQueue || { enqueue: () => ({ result: Promise.resolve({}) }) },
        updateLedger,
        allowedAgents: ['ExampleAgent'],
        defaultAgent: 'ExampleAgent',
        capabilities: {
          respond: async () => ({}), prepareAttachments: async () => [], conversation: async () => ({ accepted: true }),
          getActiveStopBinding: () => null, stop: async () => ({ stopped: false }), retry: async () => ({ accepted: false }),
          tasks: async () => [], status: async () => ({ state: 'ready', activeRequests: 0 }),
        },
        createRequestId: overrides.createRequestId || (() => 'request-1'),
        createMessageId: overrides.createMessageId || (() => 'message-1'),
      });
    }
    async function expectFailure(dispatcher, code, updateId) {
      await assert.rejects(dispatcher.dispatch({ updateId, update }), (error) => {
        assert.equal(error instanceof DispatcherError, true);
        assert.equal(error.code, code);
        assert.equal((error.message + error.stack + JSON.stringify(error)).includes(secret), false);
        return true;
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    (async () => {
      await expectFailure(build({ accessPolicy: { evaluate: () => Promise.reject(new Error(secret)) } }), 'DISPATCH_INVALID_UPDATE', '101');
      const hostile = {}; Object.defineProperty(hostile, 'authorization', { get() { throw new Error(secret); } });
      await expectFailure(build({ accessPolicy: { evaluate: () => hostile } }), 'DISPATCH_INVALID_UPDATE', '102');
      await expectFailure(build({ createRequestId: () => Promise.reject(new Error(secret)) }), 'DISPATCH_ID_INVALID', '103');
      await expectFailure(build({ createMessageId: () => Promise.reject(new Error(secret)) }), 'DISPATCH_ID_INVALID', '104');
      await expectFailure(build({ sessionStore: { getOrCreateScope: () => Promise.reject(new Error(secret)) } }), 'DISPATCH_SESSION_FAILED', '105');
      await expectFailure(build({ updateLedger: { authorizeAndQueue: () => Promise.reject(new Error(secret)) } }), 'DISPATCH_LEDGER_FAILED', '106');
      await expectFailure(build({ scopeQueue: { enqueue: () => Promise.reject(new Error(secret)) } }), 'DISPATCH_QUEUE_FAILED', '107');
      await expectFailure(build({ sessionStore: { getOrCreateScope: () => hostileThenable('session') } }), 'DISPATCH_SESSION_FAILED', '108');
      await expectFailure(build({ updateLedger: { authorizeAndQueue: () => hostileThenable('ledger') } }), 'DISPATCH_LEDGER_FAILED', '109');
      await expectFailure(build({ scopeQueue: { enqueue: () => hostileThenable('queue') } }), 'DISPATCH_QUEUE_FAILED', '110');
      await expectFailure(build({ createRequestId: () => activeThenable() }), 'DISPATCH_ID_INVALID', '111');
      process.stdout.write('sync-child-ok');
    })().catch(() => { process.exitCode = 1; });
  `;
  const child = spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '-e',
      script,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, TELEGRAM_SYNC_CONTRACT_CHILD: '1' },
    },
  );
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.equal(child.stdout, 'sync-child-ok');
  assert.equal(`${child.stdout}\n${child.stderr}`.includes('CUSTOM_THENABLE_SIDE_EFFECT'), false);
  assert.equal(`${child.stdout}\n${child.stderr}`.includes('SECONDARY_UNHANDLED'), false);
  assert.equal(`${child.stdout}\n${child.stderr}`.includes('sync-contract-secret'), false);
});

test('authorization happens before scope, attachment and conversation work', async () => {
  const { dispatcher, calls, session } = fixture();
  const result = await dispatcher.dispatch({
    updateId: '1',
    update: messageUpdate('private secret', {
      userId: OTHER_ID,
      document: { file_id: 'token-bearing-file-id' },
    }),
  });

  assert.deepEqual(result, { status: 'rejected', code: 'ACCESS_DENIED' });
  assert.equal(session.calls.getOrCreateScope.length, 0);
  assert.equal(session.calls.getActiveScope.length, 0);
  assert.equal(calls.prepareAttachments.length, 0);
  assert.equal(calls.conversation.length, 0);
  assert.deepEqual(calls.reject, [{ updateId: '1', errorCode: 'ACCESS_DENIED' }]);
  assert.deepEqual(calls.respond, [{
    type: 'access_denied', chatId: OTHER_ID, threadId: '0',
  }]);
});

test('whoami is immediate for authorized and unauthorized private users with no scope or VCP side effects', async () => {
  const { dispatcher, calls, session, queue } = fixture();
  const first = await dispatcher.dispatch({
    updateId: '2',
    update: messageUpdate('/whoami', { userId: OTHER_ID }),
  });
  const second = await dispatcher.dispatch({
    updateId: '3',
    update: messageUpdate('/whoami'),
  });

  assert.deepEqual(first, { status: 'handled', code: 'WHOAMI' });
  assert.deepEqual(second, { status: 'handled', code: 'WHOAMI' });
  assert.equal(session.calls.getOrCreateScope.length, 0);
  assert.equal(calls.prepareAttachments.length, 0);
  assert.equal(calls.conversation.length, 0);
  assert.equal(queue.snapshot().total, 0);
  assert.deepEqual(calls.respond, [
    { type: 'whoami', chatId: OTHER_ID, threadId: '0', userId: OTHER_ID },
    { type: 'whoami', chatId: OWNER_ID, threadId: '0', userId: OWNER_ID },
  ]);
});

test('durable immediate whoami updates respond once across unauthorized and authorized replay', async (t) => {
  const cases = [
    ['unauthorized', '200', messageUpdate('/whoami', { userId: OTHER_ID })],
    ['authorized', '201', messageUpdate('/whoami')],
  ];
  for (const [name, updateId, update] of cases) {
    await t.test(name, async (subtest) => {
      const { calls, dispatcher, ledger } = realImmediateFixture(subtest, { updateId, update });
      const first = await dispatcher.dispatch({ updateId, update });
      const replay = await dispatcher.dispatch({ updateId, update });

      assert.deepEqual(first, { status: 'handled', code: 'WHOAMI' });
      assert.deepEqual(replay, { status: 'duplicate', code: 'DUPLICATE' });
      assert.equal(Object.isFrozen(replay), true);
      assert.equal(calls.respond.length, 1);
      assert.equal(calls.respond[0].type, 'whoami');
      assert.equal(ledger.getUpdate(updateId).status, 'rejected');
    });
  }
});

test('durable denied, callback and membership replays remain response-idempotent', async (t) => {
  const cases = [
    {
      name: 'denied_private',
      updateId: '202',
      update: messageUpdate('denied replay', { userId: OTHER_ID }),
      first: { status: 'rejected', code: 'ACCESS_DENIED' },
      responseCount: 1,
    },
    {
      name: 'callback',
      updateId: '203',
      update: { callback_query: { id: 'callback-fixture' } },
      first: { status: 'rejected', code: 'CALLBACK_NOT_AVAILABLE' },
      responseCount: 0,
    },
    {
      name: 'membership',
      updateId: '204',
      update: { my_chat_member: {} },
      first: { status: 'ignored', code: 'MEMBERSHIP_ONLY' },
      responseCount: 0,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const { calls, dispatcher } = realImmediateFixture(subtest, scenario);
      const first = await dispatcher.dispatch(scenario);
      const replay = await dispatcher.dispatch(scenario);

      assert.deepEqual(first, scenario.first);
      assert.deepEqual(replay, { status: 'duplicate', code: 'DUPLICATE' });
      assert.equal(Object.isFrozen(replay), true);
      assert.equal(calls.respond.length, scenario.responseCount);
      if (scenario.responseCount === 1) assert.equal(calls.respond[0].type, 'access_denied');
    });
  }
});

test('start, help and unknown commands produce controlled responses inside the lane', async () => {
  const { dispatcher, calls } = fixture();
  await settle(dispatcher, '4', messageUpdate('/start'));
  await settle(dispatcher, '5', messageUpdate('/help'));
  await settle(dispatcher, '6', messageUpdate('/unknown'));

  assert.deepEqual(calls.respond.map((entry) => entry.type), ['start', 'help', 'unknown_command']);
  assert.equal(calls.conversation.length, 0);
  assert.deepEqual(calls.authorize.map((entry) => entry.orderingKey), [
    `telegram:${OWNER_ID}:0`,
    `telegram:${OWNER_ID}:0`,
    `telegram:${OWNER_ID}:0`,
  ]);
  assert.deepEqual(calls.lifecycle, [
    ['claim', 'request-4', 'telegram-dispatcher'],
    ['effect_started', 'request-4'],
    ['complete', 'request-4'],
    ['claim', 'request-5', 'telegram-dispatcher'],
    ['effect_started', 'request-5'],
    ['complete', 'request-5'],
    ['claim', 'request-6', 'telegram-dispatcher'],
    ['effect_started', 'request-6'],
    ['complete', 'request-6'],
  ]);
});

test('durable request exists before queue admission failures and remains queued for recovery', async (t) => {
  for (const admissionCode of ['QUEUE_LIMIT', 'QUEUE_ADMISSION_FAILED']) {
    await t.test(admissionCode, async () => {
      const order = [];
      const failingQueue = Object.freeze({
        enqueue() {
          order.push('enqueue');
          const error = new Error('queue fixture');
          error.code = admissionCode;
          throw error;
        },
      });
      const { dispatcher, calls, requestRecords, session } = fixture({ scopeQueue: failingQueue });

      await assert.rejects(
        dispatcher.dispatch({ updateId: '29', update: messageUpdate('durable first') }),
        (error) => assertDispatcherError(error, 'DISPATCH_QUEUE_FAILED'),
      );

      order.unshift(...calls.order);
      assert.deepEqual(order, ['authorize:request-29', 'enqueue']);
      assert.equal(requestRecords.get('request-29').status, 'queued');
      assert.equal(requestRecords.get('request-29').effectState, 'not_started');
      assert.equal(calls.reject.length, 0);
      assert.equal(session.calls.switchAgent.length, 0);
    });
  }
});

test('real SQLite ledger retains queued request when in-memory admission fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-dispatch-admission-'));
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
  const update = messageUpdate('persist before admission');
  ledger.acceptBatch([{ updateId: '60', updateType: 'message', payload: update }]);
  const accessPolicy = createAccessPolicy({
    allowedUserIds: [OWNER_ID],
    allowedChatIds: [GROUP_ID],
    groupsEnabled: false,
    botUserId: BOT_ID,
    botUsername: 'DemoBridgeBot',
  });
  const capabilities = Object.freeze({
    respond: async () => ({ delivered: true }),
    prepareAttachments: async () => [],
    conversation: async () => ({ accepted: true }),
    getActiveStopBinding: () => null,
    stop: async () => ({ stopped: false }),
    retry: async () => ({ accepted: false }),
    tasks: async () => [],
    status: async () => ({ state: 'ready', activeRequests: 0 }),
  });
  const dispatcher = createUpdateDispatcher({
    accessPolicy,
    sessionStore: store,
    scopeQueue: Object.freeze({ enqueue() { throw new Error('admission fixture'); } }),
    updateLedger: ledger,
    allowedAgents: ['ExampleAgent'],
    defaultAgent: 'ExampleAgent',
    capabilities,
    createRequestId: () => 'request-60',
    createMessageId: () => 'message-60',
  });

  await assert.rejects(
    dispatcher.dispatch({ updateId: '60', update }),
    (error) => assertDispatcherError(error, 'DISPATCH_QUEUE_FAILED'),
  );
  assert.deepEqual(
    {
      status: ledger.getRequest('request-60').status,
      effectState: ledger.getRequest('request-60').effectState,
      scopeKey: ledger.getRequest('request-60').scopeKey,
    },
    {
      status: 'queued',
      effectState: 'not_started',
      scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`,
    },
  );
});

test('planned Agent projection durably binds the next update without switching early', async () => {
  const queued = [];
  const inertQueue = Object.freeze({
    enqueue(input) {
      queued.push(input);
      return Object.freeze({
        requestId: input.requestId,
        orderingKey: input.orderingKey,
        result: new Promise(() => {}),
      });
    },
  });
  const { dispatcher, calls, requestRecords, session } = fixture({
    scopeQueue: inertQueue,
    allowedAgents: ['ExampleAgent', 'Nova'],
  });

  await dispatcher.dispatch({ updateId: '30', update: messageUpdate('/agent Nova') });
  await dispatcher.dispatch({ updateId: '31', update: messageUpdate('uses planned agent') });

  assert.equal(queued.length, 2);
  assert.equal(session.calls.switchAgent.length, 0);
  assert.deepEqual(calls.authorize.map((entry) => entry.scopeKey), [
    `telegram:${OWNER_ID}:0:ExampleAgent`,
    `telegram:${OWNER_ID}:0:Nova`,
  ]);
  assert.equal(requestRecords.get('request-30').status, 'queued');
  assert.equal(requestRecords.get('request-31').status, 'queued');
});

test('failed committed Agent switch quarantines the command and safely stops its planned successor', async () => {
  const { dispatcher, calls, requestRecords } = fixture({
    allowedAgents: ['ExampleAgent', 'Nova'],
    maxConcurrentScopes: 1,
    switchAgentFailureAgent: 'Nova',
  });

  const firstDispatch = dispatcher.dispatch({
    updateId: '61', update: messageUpdate('/agent Nova'),
  });
  const secondDispatch = dispatcher.dispatch({
    updateId: '62', update: messageUpdate('must not reach conversation'),
  });
  const [first, second] = await Promise.all([firstDispatch, secondDispatch]);

  await assert.rejects(
    first.completion,
    (error) => assertDispatcherError(error, 'DISPATCH_SESSION_FAILED'),
  );
  assert.deepEqual(await second.completion, { status: 'not_processed' });

  assert.deepEqual(calls.authorize.map((entry) => entry.scopeKey), [
    `telegram:${OWNER_ID}:0:ExampleAgent`,
    `telegram:${OWNER_ID}:0:Nova`,
  ]);
  assert.equal(requestRecords.get('request-61').status, 'needs_review');
  assert.equal(requestRecords.get('request-61').effectState, 'unknown');
  assert.equal(requestRecords.get('request-62').status, 'retryable_failed');
  assert.equal(requestRecords.get('request-62').effectState, 'not_started');
  assert.equal(requestRecords.get('request-62').errorCode, 'AGENT_ROUTE_NOT_COMMITTED');
  assert.equal(calls.prepareAttachments.length, 0);
  assert.equal(calls.conversation.length, 0);

  await settle(dispatcher, '71', messageUpdate('new arrival after failed projection'));
  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:ExampleAgent`);
});

test('committed Nova to ExampleAgent sequence keeps the final message ordered and active', async () => {
  const { dispatcher, calls, session } = fixture({
    allowedAgents: ['ExampleAgent', 'Nova'],
    maxConcurrentScopes: 1,
  });

  const admissions = await Promise.all([
    dispatcher.dispatch({ updateId: '63', update: messageUpdate('/agent Nova') }),
    dispatcher.dispatch({ updateId: '64', update: messageUpdate('/agent ExampleAgent') }),
    dispatcher.dispatch({ updateId: '65', update: messageUpdate('final ExampleAgent message') }),
  ]);
  await Promise.all(admissions.map((entry) => entry.completion));

  assert.deepEqual(session.calls.switchAgent, [
    { scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`, agent: 'Nova' },
    { scopeKey: `telegram:${OWNER_ID}:0:Nova`, agent: 'ExampleAgent' },
  ]);
  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:ExampleAgent`);
  assert.equal(calls.conversation[0].scope.currentAgent, 'ExampleAgent');
});

test('queue admission failure clears only its pending Agent projection', async () => {
  const realQueue = createScopeQueue({
    maxConcurrentScopes: 1,
    maxQueuedTotal: 10,
    maxQueuedPerScope: 5,
  });
  let rejectFirst = true;
  const hybridQueue = Object.freeze({
    enqueue(input) {
      if (rejectFirst) {
        rejectFirst = false;
        const error = new Error('queue overflow fixture');
        error.code = 'QUEUE_LIMIT';
        throw error;
      }
      return realQueue.enqueue(input);
    },
  });
  const { dispatcher, calls, requestRecords } = fixture({
    allowedAgents: ['ExampleAgent', 'Nova'],
    scopeQueue: hybridQueue,
  });

  await assert.rejects(
    dispatcher.dispatch({ updateId: '72', update: messageUpdate('/agent Nova') }),
    (error) => assertDispatcherError(error, 'DISPATCH_QUEUE_FAILED'),
  );
  await settle(dispatcher, '73', messageUpdate('must use committed ExampleAgent'));

  assert.equal(requestRecords.get('request-72').status, 'queued');
  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:ExampleAgent`);
});

test('response failure settles its projection and later routing follows persisted active Agent', async () => {
  const { dispatcher, calls, requestRecords, session } = fixture({
    allowedAgents: ['ExampleAgent', 'Nova'],
    async respond(input) {
      if (input.type === 'agent_switched') throw new Error('response failure fixture');
      return { delivered: true };
    },
  });
  const admission = await dispatcher.dispatch({
    updateId: '74', update: messageUpdate('/agent Nova'),
  });
  await assert.rejects(
    admission.completion,
    (error) => assertDispatcherError(error, 'DISPATCH_RESPONSE_FAILED'),
  );
  assert.equal(requestRecords.get('request-74').status, 'needs_review');

  session.api.switchAgent(`telegram:${OWNER_ID}:0:Nova`, 'ExampleAgent');
  await settle(dispatcher, '75', messageUpdate('follow external committed state'));
  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:ExampleAgent`);
});

test('settled Agent projections across independent lanes do not pin stale routing', async () => {
  const { dispatcher, calls, session } = fixture({
    allowedAgents: ['ExampleAgent', 'Nova'],
    groupsEnabled: true,
    maxConcurrentScopes: 2,
  });

  const admissions = await Promise.all([
    dispatcher.dispatch({ updateId: '76', update: messageUpdate('/agent Nova') }),
    dispatcher.dispatch({
      updateId: '77',
      update: messageUpdate('/agent Nova', {
        chatId: GROUP_ID, chatType: 'supergroup', threadId: 77,
      }),
    }),
  ]);
  await Promise.all(admissions.map((entry) => entry.completion));

  session.api.switchAgent(`telegram:${OWNER_ID}:0:Nova`, 'ExampleAgent');
  session.api.switchAgent(`telegram:${GROUP_ID}:77:Nova`, 'ExampleAgent');
  await Promise.all([
    settle(dispatcher, '78', messageUpdate('private committed ExampleAgent')),
    settle(dispatcher, '79', messageUpdate('group committed ExampleAgent', {
      chatId: GROUP_ID, chatType: 'supergroup', threadId: 77, replyToBot: true,
    })),
  ]);

  assert.deepEqual(calls.conversation.map((entry) => entry.scope.key).sort(), [
    `telegram:${GROUP_ID}:77:ExampleAgent`,
    `telegram:${OWNER_ID}:0:ExampleAgent`,
  ].sort());
});

test('agent lists the allowlist, switches only exact allowed names and new clears the active Agent session', async () => {
  const { dispatcher, calls, session } = fixture();
  await settle(dispatcher, '7', messageUpdate('/agent'));
  await settle(dispatcher, '8', messageUpdate('/agent Yuzu'));
  await settle(dispatcher, '9', messageUpdate('/agent yuzu'));
  await settle(dispatcher, '10', messageUpdate('/agent VCPModelAuto'));
  await settle(dispatcher, '11', messageUpdate('/new'));

  assert.deepEqual(calls.respond[0], {
    type: 'agent_list', chatId: OWNER_ID, threadId: '0',
    activeAgent: 'ExampleAgent', allowedAgents: ['ExampleAgent', 'Yuzu'],
  });
  assert.deepEqual(session.calls.switchAgent, [{
    scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`, agent: 'Yuzu',
  }]);
  assert.deepEqual(
    calls.respond.slice(1).map((entry) => entry.type),
    ['agent_switched', 'agent_not_allowed', 'agent_not_allowed', 'new_conversation'],
  );
  assert.equal(session.calls.startNewConversation.length, 1);
  assert.equal(session.calls.startNewConversation[0], `telegram:${OWNER_ID}:0:Yuzu`);
  assert.equal(calls.respond.at(-1).agent, 'Yuzu');
});

test('agent switching is serialized before the next message while ordering keys exclude Agent', async () => {
  const gate = deferred();
  let switchedResponseStarted = false;
  const { dispatcher, calls } = fixture({
    maxConcurrentScopes: 1,
    async respond(input) {
      if (input.type === 'agent_switched') {
        switchedResponseStarted = true;
        await gate.promise;
      }
      return { delivered: true };
    },
  });

  const switchAdmission = await dispatcher.dispatch({
    updateId: '12', update: messageUpdate('/agent Yuzu'),
  });
  while (!switchedResponseStarted) await new Promise((resolve) => setImmediate(resolve));
  const messageAdmission = await dispatcher.dispatch({
    updateId: '13', update: messageUpdate('after switch'),
  });

  assert.equal(calls.conversation.length, 0);
  gate.resolve();
  await switchAdmission.completion;
  await messageAdmission.completion;

  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:Yuzu`);
  assert.equal(calls.conversation[0].text, 'after switch');
  assert.deepEqual(calls.authorize.map((entry) => entry.orderingKey), [
    `telegram:${OWNER_ID}:0`, `telegram:${OWNER_ID}:0`,
  ]);
});

test('status is sanitized, tasks are owner-scoped, and retry delegates only a safe explicit owner-scoped target', async () => {
  const secret = 'vcp-secret-key';
  const { dispatcher, calls } = fixture({
    status: async () => ({ state: 'ready', activeRequests: 2, secret }),
    tasks: async () => [{ taskId: 'task-1', status: 'running', body: secret }],
    requestRecords: {
      'original-request_1': {
        requestId: 'original-request_1', ownerUserId: OWNER_ID,
        scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`, status: 'needs_review',
        replayPolicy: 'manual', effectState: 'unknown',
      },
    },
  });
  await settle(dispatcher, '14', messageUpdate('/status'));
  await settle(dispatcher, '15', messageUpdate('/tasks'));
  await settle(dispatcher, '16', messageUpdate('/retry original-request_1'));
  await settle(dispatcher, '17', messageUpdate('/retry ../../arbitrary'));
  await settle(dispatcher, '18', messageUpdate('/retry'));

  assert.deepEqual(calls.status[0], {
    ownerUserId: OWNER_ID, chatId: OWNER_ID, threadId: '0',
    scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`, agent: 'ExampleAgent',
  });
  assert.deepEqual(calls.tasks[0], {
    ownerUserId: OWNER_ID, chatId: OWNER_ID, threadId: '0',
    scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`,
  });
  assert.equal(calls.retry.length, 1);
  assert.deepEqual(calls.retry[0], {
    ownerUserId: OWNER_ID,
    chatId: OWNER_ID,
    threadId: '0',
    scopeKey: `telegram:${OWNER_ID}:0:ExampleAgent`,
    targetRequestId: 'original-request_1',
  });
  assert.equal(Object.hasOwn(calls.retry[0], 'requestId'), false);
  assert.equal(Object.hasOwn(calls.retry[0], 'messageId'), false);
  assert.equal(JSON.stringify(calls.respond).includes(secret), false);
  assert.deepEqual(calls.respond.slice(-2).map((entry) => entry.type), ['retry_invalid', 'retry_invalid']);
});

test('status exposes Telegram readiness and bounded queue counts without internal identifiers', async () => {
  const secret = 'internal-request-id-marker';
  const { dispatcher, calls } = fixture({
    status: async () => ({
      mode: 'enabled',
      state: 'ready',
      vcpReadiness: 'ready',
      pollerState: 'polling',
      activeRequests: 2,
      queuedRequests: 3,
      deadLetters: 1,
      requestIds: [secret],
    }),
  });

  await settle(dispatcher, '79', messageUpdate('/status'));

  assert.deepEqual(calls.respond.at(-1), {
    type: 'status',
    chatId: OWNER_ID,
    threadId: '0',
    agent: 'ExampleAgent',
    mode: 'enabled',
    state: 'ready',
    vcpReadiness: 'ready',
    pollerState: 'polling',
    activeRequests: 2,
    queuedRequests: 3,
    deadLetters: 1,
  });
  assert.equal(JSON.stringify(calls.respond.at(-1)).includes(secret), false);
});

test('removed persisted Agent fails closed before conversation and scope-sensitive commands', async () => {
  const { dispatcher, calls, requestRecords, session } = fixture({
    activeAgent: 'Removed',
    allowedAgents: ['ExampleAgent', 'Nova'],
  });

  for (const [updateId, text] of [
    ['32', 'ordinary'],
    ['33', '/status'],
    ['34', '/tasks'],
    ['35', '/new'],
  ]) {
    const result = await dispatcher.dispatch({ updateId, update: messageUpdate(text) });
    await result.completion;
  }

  assert.equal(calls.prepareAttachments.length, 0);
  assert.equal(calls.conversation.length, 0);
  assert.equal(calls.status.length, 0);
  assert.equal(calls.tasks.length, 0);
  assert.equal(session.calls.startNewConversation.length, 0);
  for (const updateId of ['32', '33', '34', '35']) {
    const request = requestRecords.get(`request-${updateId}`);
    assert.equal(request.scopeKey, `telegram:${OWNER_ID}:0:Removed`);
    assert.equal(request.status, 'retryable_failed');
    assert.equal(request.errorCode, 'AGENT_NOT_ALLOWED');
    assert.equal(request.effectState, 'not_started');
  }
});

test('removed active Agent can list and explicitly recover only to an allowed Agent', async () => {
  const { dispatcher, calls, requestRecords, session } = fixture({
    activeAgent: 'Removed',
    allowedAgents: ['ExampleAgent', 'Nova'],
  });

  await settle(dispatcher, '66', messageUpdate('/agent'));
  await settle(dispatcher, '67', messageUpdate('/agent Removed'));
  await settle(dispatcher, '68', messageUpdate('/agent Other'));
  await settle(dispatcher, '69', messageUpdate('/agent Nova'));
  await settle(dispatcher, '70', messageUpdate('after explicit recovery'));

  assert.deepEqual(calls.respond.map((entry) => entry.type), [
    'agent_list',
    'agent_not_allowed',
    'agent_not_allowed',
    'agent_switched',
  ]);
  assert.equal(calls.respond[0].activeAgent, null);
  assert.deepEqual(calls.respond[0].allowedAgents, ['ExampleAgent', 'Nova']);
  assert.deepEqual(session.calls.switchAgent, [{
    scopeKey: `telegram:${OWNER_ID}:0:Removed`,
    agent: 'Nova',
  }]);
  for (const updateId of ['66', '67', '68', '69']) {
    assert.equal(requestRecords.get(`request-${updateId}`).status, 'completed');
  }
  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].scope.key, `telegram:${OWNER_ID}:0:Nova`);
  assert.equal(calls.conversation[0].scope.currentAgent, 'Nova');
});

test('retry refuses unowned, wrong-scope, active, completed, and unsupported records before capability', async (t) => {
  const currentScope = `telegram:${OWNER_ID}:0:ExampleAgent`;
  const invalid = {
    other_owner: {
      ownerUserId: OTHER_ID, scopeKey: currentScope,
      status: 'needs_review', replayPolicy: 'manual',
    },
    wrong_scope: {
      ownerUserId: OWNER_ID, scopeKey: `telegram:${OWNER_ID}:71:ExampleAgent`,
      status: 'needs_review', replayPolicy: 'manual',
    },
    completed: {
      ownerUserId: OWNER_ID, scopeKey: currentScope,
      status: 'completed', replayPolicy: 'manual',
    },
    processing: {
      ownerUserId: OWNER_ID, scopeKey: currentScope,
      status: 'processing', replayPolicy: 'manual',
    },
    bad_policy: {
      ownerUserId: OWNER_ID, scopeKey: currentScope,
      status: 'needs_review', replayPolicy: 'invented',
    },
  };

  let updateId = 40;
  for (const [name, record] of Object.entries(invalid)) {
    await t.test(name, async () => {
      const targetRequestId = `target-${name}`;
      const { dispatcher, calls } = fixture({
        requestRecords: {
          [targetRequestId]: { requestId: targetRequestId, effectState: 'unknown', ...record },
        },
      });
      const result = await settle(
        dispatcher,
        String(updateId++),
        messageUpdate(`/retry ${targetRequestId}`),
      );

      assert.equal(calls.retry.length, 0);
      assert.equal(calls.getRequest.includes(targetRequestId), true);
      assert.equal(calls.respond.at(-1).type, 'retry_refused');
      assert.deepEqual(result.completion, { status: 'processed' });
    });
  }
});

test('retry delegates only valid owner-scoped retryable and needs-review records', async () => {
  const currentScope = `telegram:${OWNER_ID}:0:ExampleAgent`;
  const { dispatcher, calls } = fixture({
    requestRecords: {
      'target-needs-review': {
        requestId: 'target-needs-review', ownerUserId: OWNER_ID,
        scopeKey: currentScope, status: 'needs_review',
        replayPolicy: 'manual', effectState: 'unknown',
      },
      'target-retryable': {
        requestId: 'target-retryable', ownerUserId: OWNER_ID,
        scopeKey: currentScope, status: 'retryable_failed',
        replayPolicy: 'safe', effectState: 'not_started',
      },
    },
  });

  await settle(dispatcher, '50', messageUpdate('/retry target-needs-review'));
  await settle(dispatcher, '51', messageUpdate('/retry target-retryable'));

  assert.deepEqual(calls.getRequest, ['target-needs-review', 'target-retryable']);
  assert.deepEqual(calls.retry.map((entry) => entry.targetRequestId), [
    'target-needs-review', 'target-retryable',
  ]);
});

test('regular messages prepare authorized attachments before calling conversation with topic-aware scope', async () => {
  const order = [];
  const secretResult = 'model-body-must-not-leave-capability';
  const { dispatcher, calls } = fixture({
    groupsEnabled: true,
    prepareAttachments: async (input) => {
      order.push('attachments');
      return [{ attachmentId: 'safe-1' }];
    },
    conversation: async () => {
      order.push('conversation');
      return { accepted: true, body: secretResult };
    },
  });
  const result = await settle(dispatcher, '19', messageUpdate('continue', {
    chatId: GROUP_ID,
    chatType: 'supergroup',
    threadId: 991,
    replyToBot: true,
  }));

  assert.deepEqual(order, ['attachments', 'conversation']);
  assert.equal(calls.authorize[0].orderingKey, `telegram:${GROUP_ID}:991`);
  assert.equal(calls.authorize[0].ownerUserId, OWNER_ID);
  assert.equal(calls.conversation[0].scope.key, `telegram:${GROUP_ID}:991:ExampleAgent`);
  assert.deepEqual(calls.conversation[0].attachments, [{ attachmentId: 'safe-1' }]);
  assert.deepEqual(result.completion, { status: 'processed' });
  assert.equal(JSON.stringify(result.completion).includes(secretResult), false);
  assert.deepEqual(calls.lifecycle, [
    ['claim', 'request-19', 'telegram-dispatcher'],
    ['effect_started', 'request-19'],
    ['complete', 'request-19'],
  ]);
});

test('dispatcher owns conversation terminal state for success, throw, invalid result, and completion failure', async (t) => {
  await t.test('success', async () => {
    const { dispatcher, ledger, update } = realConversationFixture(t, {
      updateId: '90',
      conversation: async () => ({ accepted: true }),
    });
    const result = await settle(dispatcher, '90', update);
    assert.deepEqual(result.completion, { status: 'processed' });
    assert.equal(ledger.getRequest('request-90').status, 'completed');
    assert.equal(ledger.getRequest('request-90').effectState, 'confirmed');
  });

  await t.test('throw', async () => {
    const { dispatcher, ledger, update } = realConversationFixture(t, {
      updateId: '91',
      conversation: async () => { throw new Error('conversation fixture'); },
    });
    const admission = await dispatcher.dispatch({ updateId: '91', update });
    await assert.rejects(
      admission.completion,
      (error) => assertDispatcherError(error, 'DISPATCH_CONVERSATION_FAILED'),
    );
    assert.equal(ledger.getRequest('request-91').status, 'needs_review');
    assert.equal(ledger.getRequest('request-91').effectState, 'unknown');
  });

  await t.test('invalid_result', async () => {
    const { dispatcher, calls, requestRecords } = fixture({
      conversation: async () => ({ accepted: false }),
    });
    const admission = await dispatcher.dispatch({ updateId: '92', update: messageUpdate('invalid result') });
    await assert.rejects(
      admission.completion,
      (error) => assertDispatcherError(error, 'DISPATCH_CONVERSATION_FAILED'),
    );
    assert.equal(requestRecords.get('request-92').status, 'needs_review');
    assert.equal(requestRecords.get('request-92').effectState, 'unknown');
    assert.equal(calls.lifecycle.some((entry) => entry[0] === 'complete'), false);
  });

  await t.test('completion_failure', async () => {
    const { dispatcher, requestRecords } = fixture({
      conversation: async () => ({ accepted: true }),
      completeRequest: () => ({ changed: false, currentStatus: 'processing' }),
    });
    const admission = await dispatcher.dispatch({ updateId: '93', update: messageUpdate('complete fails') });
    await assert.rejects(
      admission.completion,
      (error) => assertDispatcherError(error, 'DISPATCH_LEDGER_FAILED'),
    );
    assert.equal(requestRecords.get('request-93').status, 'needs_review');
    assert.equal(requestRecords.get('request-93').effectState, 'unknown');
  });

  await t.test('effect_start_failure', async () => {
    const secret = 'effect-start-secret';
    const { dispatcher, calls, requestRecords } = fixture({
      markEffectStarted: () => Promise.reject(new Error(secret)),
    });
    const admission = await dispatcher.dispatch({
      updateId: '94', update: messageUpdate('effect start fails'),
    });
    await assert.rejects(
      admission.completion,
      (error) => assertDispatcherError(error, 'DISPATCH_LEDGER_FAILED', [secret]),
    );
    assert.equal(requestRecords.get('request-94').status, 'retryable_failed');
    assert.equal(requestRecords.get('request-94').effectState, 'not_started');
    assert.equal(requestRecords.get('request-94').errorCode, 'DISPATCH_EFFECT_NOT_STARTED');
    assert.equal(calls.conversation.length, 0);
  });
});

test('authorized media caption becomes conversation text without entering access decisions', async () => {
  const caption = 'photo @DemoBridgeBot context';
  const { dispatcher, calls } = fixture({ groupsEnabled: true });
  const result = await settle(dispatcher, '52', messageUpdate(undefined, {
    chatId: GROUP_ID,
    chatType: 'supergroup',
    threadId: 73,
    document: { file_id: 'safe-fixture' },
    caption,
    captionEntities: [{ type: 'mention', offset: 6, length: 14 }],
  }));

  assert.equal(calls.conversation.length, 1);
  assert.equal(calls.conversation[0].text, caption);
  assert.equal(JSON.stringify(result.admission).includes(caption), false);
});

test('slash stop bypasses a blocked lane and cancels only exact owner/chat/thread binding', async () => {
  const running = deferred();
  const started = deferred();
  const binding = Object.freeze({
    requestId: 'active-request', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '0', draftId: '77',
  });
  const { dispatcher, calls } = fixture({
    activeStopBinding: binding,
    conversation: async () => {
      started.resolve();
      return running.promise;
    },
  });
  const ordinary = await dispatcher.dispatch({ updateId: '20', update: messageUpdate('long task') });
  await started.promise;

  const stopped = await dispatcher.dispatch({ updateId: '21', update: messageUpdate('/stop') });
  assert.deepEqual(stopped, { status: 'handled', code: 'STOPPED' });
  assert.equal(calls.stop.length, 1);
  assert.deepEqual(calls.stop[0], {
    requestId: 'active-request', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '0', draftId: '77', source: 'command',
  });
  assert.equal(calls.conversation.length, 1);

  running.resolve({ accepted: true });
  await ordinary.completion;
});

test('native stop requires exact private chat/thread/draft and cannot cancel a different binding', async () => {
  const { dispatcher, calls, setActiveStopBinding } = fixture();
  setActiveStopBinding(Object.freeze({
    requestId: 'active-request', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '71', draftId: '88',
  }));

  const mismatch = await dispatcher.dispatch({
    updateId: '22',
    update: {
      stopped_message_generation: {
        chat: { id: OWNER_ID, type: 'private' },
        message_thread_id: 71,
        draft_id: 99,
      },
    },
  });
  assert.deepEqual(mismatch, { status: 'handled', code: 'NO_ACTIVE_REQUEST' });
  assert.equal(calls.stop.length, 0);
  assert.deepEqual(calls.stopBinding[0], {
    ownerUserId: OWNER_ID, chatId: OWNER_ID, threadId: '71', draftId: '99',
  });

  const matched = await dispatcher.dispatch({
    updateId: '23',
    update: {
      stopped_message_generation: {
        chat: { id: OWNER_ID, type: 'private' },
        message_thread_id: '71',
        draft_id: '88',
      },
    },
  });
  assert.deepEqual(matched, { status: 'handled', code: 'STOPPED' });
  assert.equal(calls.stop.length, 1);
  assert.equal(calls.stop[0].source, 'native');
  assert.equal(calls.stop[0].requestId, 'active-request');
  assert.deepEqual(calls.stopBinding[1], {
    ownerUserId: OWNER_ID, chatId: OWNER_ID, threadId: '71', draftId: '88',
  });
});

test('consumed stop update is at-most-once and cannot stop a later binding', async () => {
  const { dispatcher, calls, setActiveStopBinding } = fixture();
  setActiveStopBinding(Object.freeze({
    requestId: 'binding-A', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '0', draftId: '81',
  }));
  const first = await dispatcher.dispatch({ updateId: '80', update: messageUpdate('/stop') });
  assert.deepEqual(first, { status: 'handled', code: 'STOPPED' });

  setActiveStopBinding(Object.freeze({
    requestId: 'binding-B', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '0', draftId: '82',
  }));
  const replay = await dispatcher.dispatch({ updateId: '80', update: messageUpdate('/stop') });

  assert.deepEqual(replay, { status: 'duplicate', code: 'CONTROL_DUPLICATE' });
  assert.deepEqual(calls.stop.map((entry) => entry.requestId), ['binding-A']);
  assert.equal(calls.stopBinding.length, 1);
  assert.deepEqual(calls.reject, [
    { updateId: '80', errorCode: 'CONTROL_CONSUMED' },
    { updateId: '80', errorCode: 'CONTROL_CONSUMED' },
  ]);
});

test('consumed native draft mismatch cannot be replayed against a later matching binding', async () => {
  const { dispatcher, calls, setActiveStopBinding } = fixture();
  setActiveStopBinding(Object.freeze({
    requestId: 'native-A', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '9', draftId: '91',
  }));
  const update = {
    stopped_message_generation: {
      chat: { id: OWNER_ID, type: 'private' },
      message_thread_id: 9,
      draft_id: 92,
    },
  };
  const mismatch = await dispatcher.dispatch({ updateId: '81', update });
  assert.deepEqual(mismatch, { status: 'handled', code: 'NO_ACTIVE_REQUEST' });

  setActiveStopBinding(Object.freeze({
    requestId: 'native-B', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '9', draftId: '92',
  }));
  const replay = await dispatcher.dispatch({ updateId: '81', update });

  assert.deepEqual(replay, { status: 'duplicate', code: 'CONTROL_DUPLICATE' });
  assert.equal(calls.stop.length, 0);
  assert.equal(calls.stopBinding.length, 1);
});

test('stop reports success only for an exact plain capability outcome', async (t) => {
  const binding = Object.freeze({
    requestId: 'outcome-binding', ownerUserId: OWNER_ID,
    chatId: OWNER_ID, threadId: '0', draftId: '93',
  });
  const cases = [
    ['stopped_false', { stopped: false, requestId: 'outcome-binding' }],
    ['wrong_request', { stopped: true, requestId: 'different-binding' }],
  ];
  let updateId = 82;
  for (const [name, outcome] of cases) {
    await t.test(name, async () => {
      const { dispatcher, calls } = fixture({ activeStopBinding: binding, stop: async () => outcome });
      const result = await dispatcher.dispatch({
        updateId: String(updateId++), update: messageUpdate('/stop'),
      });
      assert.deepEqual(result, { status: 'handled', code: 'CONTROL_RACE' });
      assert.equal(calls.respond.some((entry) => entry.type === 'stop_result'), false);
      assert.equal(calls.respond.at(-1).type, 'no_active_request');
    });
  }

  await t.test('hostile_outcome', async () => {
    const secret = 'stop-outcome-secret';
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'stopped', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(secret);
      },
    });
    hostile.requestId = 'outcome-binding';
    const { dispatcher, calls } = fixture({ activeStopBinding: binding, stop: async () => hostile });
    await assert.rejects(
      dispatcher.dispatch({ updateId: String(updateId++), update: messageUpdate('/stop') }),
      (error) => assertDispatcherError(error, 'DISPATCH_STOP_FAILED', [secret]),
    );
    assert.equal(getterCalls, 0);
    assert.equal(calls.respond.some((entry) => entry.type === 'stop_result'), false);
  });

  await t.test('extra_outcome_fields', async () => {
    const { dispatcher, calls } = fixture({
      activeStopBinding: binding,
      stop: async () => ({
        stopped: true,
        requestId: 'outcome-binding',
        untrusted: true,
      }),
    });
    await assert.rejects(
      dispatcher.dispatch({ updateId: String(updateId++), update: messageUpdate('/stop') }),
      (error) => assertDispatcherError(error, 'DISPATCH_STOP_FAILED'),
    );
    assert.equal(calls.respond.some((entry) => entry.type === 'stop_result'), false);
  });
});

test('groups-disabled, callbacks and membership updates never enter conversation handling', async () => {
  const { dispatcher, calls } = fixture();
  const group = await dispatcher.dispatch({
    updateId: '24',
    update: messageUpdate('/status', {
      chatId: GROUP_ID, chatType: 'supergroup', threadId: 71,
    }),
  });
  const callback = await dispatcher.dispatch({
    updateId: '25', update: { callback_query: { id: 'opaque-callback' } },
  });
  const membership = await dispatcher.dispatch({
    updateId: '26', update: { my_chat_member: { chat: { id: GROUP_ID } } },
  });

  assert.deepEqual(group, { status: 'rejected', code: 'ACCESS_DENIED' });
  assert.deepEqual(callback, { status: 'rejected', code: 'CALLBACK_NOT_AVAILABLE' });
  assert.deepEqual(membership, { status: 'ignored', code: 'MEMBERSHIP_ONLY' });
  assert.equal(calls.conversation.length, 0);
  assert.equal(calls.prepareAttachments.length, 0);
});

test('hostile and unknown updates become stable content-safe dispatcher errors', async () => {
  const secret = '123456:bot-token-fixture';
  const hostile = {};
  Object.defineProperty(hostile, 'message', {
    enumerable: true,
    get() { throw new Error(secret); },
  });
  const { dispatcher } = fixture();

  await assert.rejects(
    dispatcher.dispatch({ updateId: '27', update: hostile }),
    (error) => assertDispatcherError(error, 'DISPATCH_INVALID_UPDATE', [secret]),
  );
  await assert.rejects(
    dispatcher.dispatch({ updateId: '28', update: { edited_message: { text: secret } } }),
    (error) => assertDispatcherError(error, 'DISPATCH_UNSUPPORTED_UPDATE', [secret]),
  );
});
