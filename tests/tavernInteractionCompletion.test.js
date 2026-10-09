const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');

function context(overrides = {}) {
  return {
    originalBody: { model: 'test', messages: [] },
    pluginManager: { messagePreprocessors: new Map() },
    abortController: new AbortController(),
    ToolCallParser: {
      parse: text => text.includes('TOOL') ? [{ name: 'test' }] : [],
      separate: calls => ({ normal: calls, archery: [] })
    },
    toolExecutor: { executeAll: async () => [{ success: true, content: [{ type: 'text', text: 'ok' }] }] },
    apiRetries: 1,
    apiRetryDelay: 0,
    maxVCPLoopStream: 3,
    maxVCPLoopNonStream: 3,
    ...overrides
  };
}

function response() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.write = (_chunk, callback) => { if (callback) callback(); return true; };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.send = () => res.end();
  return res;
}

function jsonResponse(content, finish_reason = 'stop', extra = {}, ok = true) {
  const text = JSON.stringify({ choices: [{ message: { content, ...extra }, finish_reason }] });
  return { ok, arrayBuffer: async () => Buffer.from(text) };
}

function streamResponse(content, reason = 'stop', done = true, suffix = '') {
  const body = new PassThrough();
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] })}\n\n`;
  setImmediate(() => body.end(payload + suffix + (done ? 'data: [DONE]' : '')));
  return { ok: true, body };
}

for (const [name, content, reason, expected] of [
  ['正文正常结束', 'hello', 'stop', true],
  ['空回复', ' ', 'stop', false],
  ['长度截断', 'partial', 'length', false],
  ['内容过滤', 'partial', 'content_filter', false],
  ['缺失结束原因', 'partial', null, false]
]) {
  test(`非流式：${name}`, async () => {
    const result = await new NonStreamHandler(context()).handle({}, response(), jsonResponse(content, reason));
    assert.equal(result.completed, expected);
  });
}

for (const [name, content, reason, done, expected, suffix] of [
  ['正常结束', 'hello', 'stop', true, true, ''],
  ['仅正常结束原因', 'hello', 'stop', false, true, ''],
  ['仅 DONE 兼容', 'hello', null, true, true, ''],
  ['空回复', ' ', 'stop', true, false, ''],
  ['静默截断', 'partial', null, false, false, ''],
  ['长度截断', 'partial', 'length', true, false, ''],
  ['错误事件', 'hello', 'stop', true, false, 'data: {"error":"failed"}\n\n'],
  ['损坏事件', 'hello', 'stop', true, false, 'data: {broken\n\n']
]) {
  test(`流式：${name}`, async () => {
    const result = await new StreamHandler(context()).handle({}, response(), streamResponse(content, reason, done, suffix));
    assert.equal(result.completed, expected);
  });
}

test('流式：提前 close 和中止不提交', async () => {
  for (const abort of [false, true]) {
    const ctx = context();
    const body = new PassThrough();
    const pending = new StreamHandler(ctx).handle({}, response(), { ok: true, body });
    setImmediate(() => abort ? ctx.abortController.abort() : body.destroy());
    assert.equal((await pending).completed, false);
  }
});

test('两类处理器：工具中间轮不掩盖失败，成功整轮只返回一次成功', async () => {
  for (const Handler of [StreamHandler, NonStreamHandler]) {
    for (const mode of ['success', 'failure', 'limit']) {
      const streaming = Handler === StreamHandler;
      const make = text => streaming ? streamResponse(text) : jsonResponse(text);
      const ctx = context({
        maxVCPLoopStream: mode === 'limit' ? 1 : 3,
        maxVCPLoopNonStream: mode === 'limit' ? 1 : 3,
        fetchWithRetry: async () => mode === 'failure'
          ? { ok: false, arrayBuffer: async () => Buffer.from('{}') }
          : make(mode === 'limit' ? 'TOOL' : 'final')
      });
      const result = await new Handler(ctx).handle({}, response(), make('TOOL'));
      assert.equal(result.completed, mode === 'success');
    }
  }
});

test('非流式：纯推理重试耗尽不提交，重试成功可提交', async () => {
  for (const succeeds of [false, true]) {
    const ctx = context({
      apiRetries: 2,
      fetchWithRetry: async () => succeeds
        ? jsonResponse('final')
        : jsonResponse('', 'stop', { reasoning_content: 'thinking' })
    });
    const result = await new NonStreamHandler(ctx).handle(
      {}, response(), jsonResponse('', 'stop', { reasoning_content: 'thinking' })
    );
    assert.equal(result.completed, succeeds);
  }
});

test('插件：预处理只读、请求隔离、一次提交、取消防抖及串行保存', async () => {
  const filename = path.resolve(__dirname, '../Plugin/VCPTavern/VCPTavern.js');
  const writes = [];
  let active = 0;
  let maxActive = 0;
  const preset = { rules: [{ enabled: true, type: 'embed', target: 'last_user', position: 'before', content: '{{LastChatTime}} {{TimeSinceLastChat}}' }] };
  const fakeFs = {
    mkdir: async () => {},
    readdir: async () => ['daily.json'],
    readFile: async file => file.endsWith('access_logs.json') ? '{"daily:A":1000}' : JSON.stringify(preset),
    writeFile: async (_file, text) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setImmediate(resolve));
      writes.push(JSON.parse(text));
      active--;
    }
  };
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename), console,
    process: { env: {} },
    require: name => name === 'fs' ? { promises: fakeFs } : name === 'express' ? {} : require(name)
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const plugin = sandbox.module.exports;
  await plugin.initialize({});
  const messages = id => [{ role: 'system', content: `{{VCPTavern::daily::${id}}}` }, { role: 'user', content: 'hello' }];
  const a = { tavernInteraction: {} };
  const b = { tavernInteraction: {} };
  const output = await plugin.processMessages(messages('A'), { ...a });
  await plugin.processMessages(messages('B'), { ...b });
  assert.match(output[1].content, /上次对话时间/);
  assert.equal(writes.length, 0);
  await Promise.all([a.tavernInteraction.commit(), b.tavernInteraction.commit()]);
  await a.tavernInteraction.commit();
  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);
  assert(writes.at(-1)['daily:A'] > 1000);
  assert(writes.at(-1)['daily:B']);
  const next = { tavernInteraction: {} };
  await plugin.processMessages(messages('A'), next);
  await next.tavernInteraction.commit();
  assert.equal(writes.length, 3);
  await plugin.processMessages(messages('A'), {});
  assert.equal(writes.length, 3);
  await plugin.shutdown();
});

const { createInteractionCompletion } = require('../modules/handlers/interactionCompletion');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('统一结算：finish 和处理器结果先后顺序均只提交一次', async () => {
  for (const finishFirst of [true, false]) {
    const res = response();
    const calls = [];
    const ring = { recordAIResponseWithMeta: (...args) => calls.push(['ring', ...args]) };
    const completion = createInteractionCompletion({
      res, signal: new AbortController().signal,
      oneRingModule: ring, oneRingMeta: { agentName: 'A', turnId: 'turn' },
      tavernInteraction: { commit: () => calls.push(['tavern']) }
    });
    if (finishFirst) res.emit('finish');
    completion.accept({ completed: true, aiText: 'final' });
    if (!finishFirst) {
      await flush();
      assert.equal(calls.length, 0);
      res.emit('finish');
    }
    completion.accept({ completed: true, aiText: 'duplicate' });
    res.emit('finish');
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0][2], 'final');
    assert.deepEqual(calls[0][3], { completed: true });
  }
});

test('统一结算：上游失败、断联和取消只中止，不入库或刷新时间', async () => {
  for (const mode of ['invalid', 'close', 'abort', 'exception']) {
    const res = response();
    const controller = new AbortController();
    const calls = [];
    const completion = createInteractionCompletion({
      res, signal: controller.signal,
      oneRingModule: {
        recordAIResponseWithMeta: () => calls.push('record'),
        markAIResponseAborted: meta => calls.push(meta.turnId)
      },
      oneRingMeta: { agentName: 'A', turnId: 'pending' },
      tavernInteraction: { commit: () => calls.push('tavern') }
    });
    if (mode === 'invalid') completion.accept({ completed: false, aiText: 'partial' });
    if (mode === 'close') res.emit('close');
    if (mode === 'abort') controller.abort();
    if (mode === 'exception') completion.fail();
    completion.accept({ completed: true, aiText: 'late' });
    res.emit('finish');
    await flush();
    assert.deepEqual(calls, ['pending']);
  }
});

test('OneRing：显式失败禁止 insert/update/摘要，成功及旧入口兼容', async () => {
  const filename = path.resolve(__dirname, '../Plugin/OneRing/OneRing.js');
  const calls = [];
  const fakeDb = {
    markPostTurnAborted: (_agent, turn) => calls.push(['abort', turn]),
    insertMessage: (_agent, message) => { calls.push(['insert', message.content]); return { lastInsertRowid: 1 }; },
    updateMessageById: (_agent, id, text) => { calls.push(['update', id, text]); return { changes: 1 }; },
    completePostTurn: (_agent, turn) => { calls.push(['complete', turn]); return { changes: 1 }; }
  };
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename), console, process,
    require: name => {
      if (name === './OneRingDB.js') return fakeDb;
      if (name === './OneRingMemo.js') return { DEFAULT_CONFIG: {}, scheduleAutoGenerate: () => calls.push(['memo']) };
      if (name === './OneRingSnapshot.js') return { contentHash: text => text };
      if (name === './OneRingFuzzy.js') return { extractText: text => text };
      if (name.startsWith('./') || name === 'chokidar') return {};
      return require(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const ring = sandbox.module.exports;
  const meta = { agentName: 'A', frontendSource: 'test', turnId: 'pending', responseMessageIdToUpdate: 42 };
  for (const entry of ['recordAIResponse', 'recordAIResponseWithMeta', 'recordAIResponseFromMessages']) {
    const messages = [];
    messages.__oneRingMeta = meta;
    await ring[entry](entry.endsWith('FromMessages') ? messages : meta, 'partial', { completed: false });
  }
  assert.deepEqual(calls, [['abort', 'pending'], ['abort', 'pending'], ['abort', 'pending']]);
  calls.length = 0;
  await ring.recordAIResponseWithMeta(meta, 'final', { completed: true });
  assert.deepEqual(calls, [['update', 42, 'final'], ['complete', 'pending']]);
  calls.length = 0;
  await ring.recordAIResponseWithMeta({ ...meta, responseMessageIdToUpdate: null }, 'new', { completed: true });
  assert.deepEqual(calls, [['insert', 'new'], ['complete', 'pending'], ['memo']]);
  calls.length = 0;
  await ring.recordAIResponseWithMeta(meta, '');
  assert.deepEqual(calls, [['abort', 'pending']]);
  calls.length = 0;
  await ring.recordAIResponse(meta, 'legacy');
  assert.deepEqual(calls, [['update', 42, 'legacy'], ['complete', 'pending']]);
});