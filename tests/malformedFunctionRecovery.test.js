'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const StreamHandler = require('../modules/handlers/streamHandler');

const frame = (delta, finish_reason = null, native_finish_reason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason, native_finish_reason }] })}\n\n`;
const failed = frame({ content: '' }) +
  frame({ content: null }, 'content_filter', 'malformed_function_call') + 'data: [DONE]\n\n';
const success = text => frame({ content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n';
function response(text, split = false) {
  const bytes = Buffer.from(text);
  return { ok: true, status: 200, body: Readable.from(split
    ? Array.from(bytes, b => Buffer.from([b])) : [bytes]) };
}
function setup(fetch, overrides = {}) {
  const controller = new AbortController();
  const res = {
    writableEnded: false, destroyed: false, output: '',
    write(s, callback) { this.output += s; if (callback) callback(); return true; },
    end() { this.writableEnded = true; }
  };
  const context = {
    originalBody: { model: 'hydrogen', messages: [{ role: 'user', content: 'hello' }] },
    apiUrl: 'https://invalid.test', apiKey: 'not-a-key', abortController: controller,
    ToolCallParser: { parse: () => [] },
    fetchWithRetry: fetch, maxVCPLoopStream: 3,
    ...overrides
  };
  return { handler: new StreamHandler(context), res, controller, context };
}
for (const split of [false, true]) {
  test(`empty malformed FC recovers on same live connection; split=${split}`, async () => {
    let count = 0;
    const s = setup(async (url, options, retry) => {
      count++;
      assert.equal(s.res.writableEnded, false);
      assert.doesNotMatch(s.res.output, /content_filter|malformed_function_call|\[DONE\]|"finish_reason":"stop"/);
      const body = JSON.parse(options.body);
      assert.equal(body.messages.at(-1).role, 'user');
      assert.match(body.messages.at(-1).content, /你的上一个回复/);
      assert.equal(body.messages.length, 2);
      assert.equal(retry.retries, 1);
      return response(success('恢复成功'), split);
    });
    const result = await s.handler.handle({}, s.res, response(failed, split));
    assert.equal(count, 1);
    assert.equal(result.completed, true);
    assert.equal(result.aiText, '恢复成功');
    assert.match(s.res.output, /恢复成功/);
    assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
    assert.equal(s.context.originalBody.messages.length, 1);
  });
}
test('second malformed response ends with explicit error and never executes failed tools', async () => {
  let count = 0;
  const s = setup(async () => { count++; return response(failed); });
  const result = await s.handler.handle({}, s.res, response(failed));
  assert.equal(count, 1);
  assert.equal(result.completed, false);
  assert.equal(result.aiText, '');
  assert.match(s.res.output, /\[ERROR\]/);
  assert.doesNotMatch(s.res.output, /"finish_reason":"content_filter"/);
  assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
});
test('malformed frame without trailing newline is intercepted', async () => {
  let count = 0;
  const s = setup(async () => { count++; return response(success('ok')); });
  const result = await s.handler.handle({}, s.res, response(failed.split('data: [DONE]')[0].trimEnd()));
  assert.equal(count, 1);
  assert.equal(result.completed, true);
  assert.doesNotMatch(s.res.output, /content_filter/);
});
test('ordinary content filter does not trigger semantic recovery', async () => {
  const s = setup(async () => { throw new Error('must not retry'); });
  const result = await s.handler.handle({}, s.res, response(frame({}, 'content_filter') + 'data: [DONE]\n\n'));
  assert.equal(result.completed, false);
  assert.match(s.res.output, /content_filter/);
});
test('visible content followed by malformed FC is not replayed or executed', async () => {
  const s = setup(async () => { throw new Error('must not retry'); }, {
    ToolCallParser: { parse: text => { assert.equal(text, ''); return []; } }
  });
  const result = await s.handler.handle({}, s.res, response(frame({ content: 'partial' }) + failed));
  assert.equal(result.completed, false);
  assert.equal(result.aiText, '');
  assert.match(s.res.output, /partial/);
  assert.match(s.res.output, /\[ERROR\]/);
});
test('abort during recovery fetch prevents new stream consumption and final DONE', async () => {
  const s = setup(async () => {
    s.controller.abort();
    return response(success('must not appear'));
  });
  const result = await s.handler.handle({}, s.res, response(failed));
  assert.equal(result.completed, false);
  assert.doesNotMatch(s.res.output, /must not appear|\[DONE\]/);
});
test('tool-loop recovery does not repeat previous tool execution', async () => {
  let executed = 0;
  let fetched = 0;
  const s = setup(async (_url, options) => {
    fetched++;
    if (fetched === 1) return response(failed);
    const body = JSON.parse(options.body);
    assert.match(body.messages.at(-1).content, /你的上一个回复/);
    assert.ok(body.messages.some(m => m.role === 'assistant' && m.content === 'CALL'));
    return response(success('tool complete'));
  }, {
    ToolCallParser: {
      parse: text => text === 'CALL' ? [{ name: 'demo' }] : [],
      separate: calls => ({ normal: calls, archery: [] })
    },
    toolExecutor: {
      executeAll: async () => {
        executed++;
        return [{ success: true, content: [{ type: 'text', text: 'result' }] }];
      }
    },
    isToolResultError: () => false
  });
  const result = await s.handler.handle({}, s.res, response(success('CALL')));
  assert.equal(executed, 1);
  assert.equal(fetched, 2);
  assert.equal(result.completed, true);
  assert.equal(result.aiText, 'CALL\ntool complete');
  assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
});