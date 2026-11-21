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
    ToolCallParser: { parse: () => [] }
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

const RealToolCallParser = require('../modules/vcpLoop/toolCallParser');
const bodyTool = [
  '<<<[TOOL_REQUEST]>>>',
  'valet:「始」Kerr「末」,',
  'tool_name:「始」demo「末」,',
  'command:「始」check「末」',
  '<<<[END_TOOL_REQUEST]>>>'
].join('\n');

function toolSetup(responses, overrides = {}) {
  const stats = { fetched: 0, executed: 0, calls: [] };
  const s = setup(async () => {
    const text = responses[stats.fetched++];
    assert.notEqual(text, undefined, 'unexpected extra upstream request');
    return response(text);
  }, {
    ToolCallParser: RealToolCallParser,
    toolExecutor: {
      executeAll: async calls => {
        stats.executed++;
        stats.calls.push(...calls);
        return calls.map(() => ({ success: true, content: [{ type: 'text', text: 'result' }] }));
      }
    },
    isToolResultError: () => false,
    ...overrides
  });
  return { ...s, stats };
}

for (const split of [false, true]) {
  test(`complete VCP body survives malformed native FC and executes once; split=${split}`, async () => {
    const s = toolSetup([success('done')]);
    const nativeDuplicate = frame({ tool_calls: [{
      index: 0, id: 'native-duplicate', type: 'function',
      function: { name: 'demo', arguments: '{"command":"check"}' }
    }] });
    const result = await s.handler.handle({}, s.res,
      response(frame({ content: bodyTool }) + nativeDuplicate + failed, split));
    assert.equal(s.stats.executed, 1);
    assert.equal(s.stats.calls.length, 1);
    assert.equal(s.stats.calls[0].name, 'demo');
    assert.equal(s.stats.fetched, 1, 'only fetch tool continuation, no correction request');
    assert.equal(result.completed, true);
    assert.equal(result.aiText, `${bodyTool}\ndone`);
    assert.doesNotMatch(s.res.output, /\[ERROR\]|content_filter|native-duplicate/);
    assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
  });
}

test('recovery response containing complete VCP body also survives malformed FC', async () => {
  const s = toolSetup([frame({ content: bodyTool }) + failed, success('done')]);
  const result = await s.handler.handle({}, s.res, response(failed));
  assert.equal(s.stats.executed, 1);
  assert.equal(s.stats.calls.length, 1);
  assert.equal(s.stats.fetched, 2);
  assert.equal(result.completed, true);
  assert.doesNotMatch(s.res.output, /\[ERROR\]/);
});

test('complete block followed by incomplete block executes only complete request', async () => {
  const s = toolSetup([success('done')]);
  const text = bodyTool + '\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」unfinished';
  const result = await s.handler.handle({}, s.res, response(frame({ content: text }) + failed));
  assert.equal(s.stats.calls.length, 1);
  assert.equal(s.stats.calls[0].name, 'demo');
  assert.equal(result.completed, true);
});

for (const [label, text, overrides] of [
  ['incomplete block', '<<<[TOOL_REQUEST]>>>\ntool_name:「始」demo「末」', {}],
  ['thinking block', `<think>\n${bodyTool}\n</think>`, {}],
  ['disabled tools', bodyTool, { vcpToolUseForbidden: true }]
]) {
  test(`malformed FC must not execute ${label}`, async () => {
    const s = toolSetup([], overrides);
    const result = await s.handler.handle({}, s.res, response(frame({ content: text }) + failed));
    assert.equal(s.stats.executed, 0);
    assert.equal(s.stats.fetched, 0);
    assert.equal(result.completed, false);
    assert.match(s.res.output, /\[ERROR\]/);
  });
}

for (const bad of ['data: {broken-json}\n\n',
  `data: ${JSON.stringify({ error: { message: 'upstream error' } })}\n\n`]) {
  test(`payload errors prevent accepting body tools: ${bad.trim()}`, async () => {
    const s = toolSetup([]);
    const result = await s.handler.handle({}, s.res,
      response(frame({ content: bodyTool }) + bad + failed));
    assert.equal(s.stats.executed, 0);
    assert.equal(s.stats.fetched, 0);
    assert.equal(result.completed, false);
  });
}

const { PassThrough } = require('node:stream');

test('complete tool tail takes over after 15s despite heartbeat/native FC traffic', { timeout: 22000 }, async () => {
  const s = toolSetup([success('done')]);
  const upstream = new PassThrough();
  const started = Date.now();
  const pending = s.handler.handle({}, s.res, { ok: true, status: 200, body: upstream });
  // Delimiter crosses SSE frames.
  upstream.write(frame({ content: bodyTool.slice(0, -8) }));
  upstream.write(frame({ content: bodyTool.slice(-8) }));
  const noise = setInterval(() => {
    upstream.write(': heartbeat\n\n');
    upstream.write(frame({ tool_calls: [{ index: 0, function: { arguments: 'noise' } }] }));
  }, 100);
  try {
    const result = await pending;
    assert.ok(Date.now() - started >= 14900);
    assert.ok(Date.now() - started < 21000);
    assert.equal(upstream.destroyed, true);
    assert.equal(s.controller.signal.aborted, false);
    assert.equal(s.stats.executed, 1);
    assert.equal(s.stats.fetched, 1);
    assert.equal(result.completed, true);
    assert.doesNotMatch(s.res.output, /响应超时|STREAM_READ_ERROR|tool_calls/);
    assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
  } finally {
    clearInterval(noise);
    upstream.destroy();
  }
});

for (const mode of ['close', 'error', 'end']) {
  test(`complete tool tail survives upstream ${mode}`, async () => {
    const s = toolSetup([success('done')]);
    const upstream = new PassThrough();
    const pending = s.handler.handle({}, s.res, { ok: true, status: 200, body: upstream });
    upstream.write(frame({ content: bodyTool }));
    if (mode === 'error') upstream.destroy(new Error('connection reset'));
    else if (mode === 'close') upstream.destroy();
    else upstream.end();
    const result = await pending;
    assert.equal(s.stats.executed, 1);
    assert.equal(s.stats.fetched, 1);
    assert.equal(s.controller.signal.aborted, false);
    assert.equal(result.completed, true);
    assert.doesNotMatch(s.res.output, /STREAM_READ_ERROR|\[ERROR\]/);
  });
}

for (const [label, text, overrides] of [
  ['partial tool', bodyTool.slice(0, -5), {}],
  ['body after tool', bodyTool + '\nnot finished', {}],
  ['thought after tool', bodyTool + '\n<think>unfinished', {}],
  ['tool in thought', '<think>\n' + bodyTool, {}],
  ['disabled', bodyTool, { vcpToolUseForbidden: true }]
]) {
  test(`abnormal close must not execute ${label}`, async () => {
    const s = toolSetup([], overrides);
    const upstream = new PassThrough();
    const pending = s.handler.handle({}, s.res, { ok: true, status: 200, body: upstream });
    upstream.write(frame({ content: text }));
    upstream.destroy();
    const result = await pending;
    assert.equal(s.stats.executed, 0);
    assert.equal(s.stats.fetched, 0);
    assert.equal(result.completed, false);
  });
}

test('explicit user abort after complete tool tail never executes tools', async () => {
  const s = toolSetup([]);
  const upstream = new PassThrough();
  const pending = s.handler.handle({}, s.res, { ok: true, status: 200, body: upstream });
  upstream.write(frame({ content: bodyTool }));
  s.controller.abort();
  const result = await pending;
  assert.equal(s.stats.executed, 0);
  assert.equal(s.stats.fetched, 0);
  assert.equal(result.completed, false);
});
const echoedResultHeader = '<!-- ' + 'VCP_TOOL_PAYLOAD -->';
const echoedResultText = 'synthetic assistant echo';

function streamedText(output) {
  return output.split('\n').filter(line => line.startsWith('data: {')).map(line =>
    JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''
  ).join('');
}
function assertAssistantText(text, firstTurn) {
  assert.ok(text.startsWith(`${firstTurn}\n`), JSON.stringify(text));
  assert.ok(text.endsWith('\ndone'), JSON.stringify(text));
}

for (const [label, input] of [
  ['same frame as the complete call', frame({ content: `${bodyTool}\n${echoedResultHeader}\n${echoedResultText}` })],
  ['split across frames after the call', [
    bodyTool, '\nu', 'ser\n<!', '-- VCP_', 'TOOL_PAYLOAD -->\n', echoedResultText
  ].map(content => frame({ content })).join('')],
  ['last SSE line without a newline', frame({ content: bodyTool }) +
    frame({ content: `\n${echoedResultHeader}\n${echoedResultText}` }).trimEnd()]
]) {
  test(`tool result echo is cut before forwarding: ${label}`, async () => {
    const s = toolSetup([]);
    let messages;
    s.context.fetchWithRetry = async (_url, opts) => {
      s.stats.fetched++;
      messages = JSON.parse(opts.body).messages;
      return response(success('done'));
    };
    const result = await s.handler.handle({}, s.res, response(input));
    assert.doesNotMatch(streamedText(s.res.output), /synthetic assistant echo/);
    assert.doesNotMatch(result.aiText, /synthetic assistant echo/);
    assert.doesNotMatch(streamedText(s.res.output), /VCP_TOOL_PAYLOAD|(?:^|\n)user\n/);
    assertAssistantText(streamedText(s.res.output), bodyTool);
    assertAssistantText(result.aiText, bodyTool);
    assert.equal(s.stats.executed, 1);
    assert.equal(s.stats.fetched, 1);
    assert.equal(result.completed, true);
    assert.ok(messages.some(message => message.role === 'assistant' && message.content === bodyTool));
    assert.ok(messages.some(message => message.role === 'user' && message.content.includes('"text":"result"')));
    assert.equal((s.res.output.match(/data: \[DONE\]/g) || []).length, 1);
  });
}

for (const [label, chunks, sharesFrame] of [
  ['ordinary continuation', ['\nu', 'ser guide follows.']],
  ['ordinary continuation sharing the call frame', ['\nu', 'ser guide follows.'], true],
  ['fenced protocol example', ['\n```html\n', echoedResultHeader, '\n```']],
  ['partial marker at normal EOF', ['\n<!-- VCP_']]
]) {
  test(`tool result echo guard preserves ${label}`, async () => {
    const s = toolSetup([success('done')]);
    const frames = sharesFrame ? [bodyTool + chunks[0], ...chunks.slice(1)] : [bodyTool, ...chunks];
    const result = await s.handler.handle({}, s.res, response(
      frames.map(content => frame({ content })).join('') + frame({}, 'stop') + 'data: [DONE]\n\n'));
    assertAssistantText(streamedText(s.res.output), bodyTool + chunks.join(''));
    assertAssistantText(result.aiText, bodyTool + chunks.join(''));
    assert.equal(s.stats.executed, 1);
    assert.equal(result.completed, true);
  });
}

test('tool result echo takes over while upstream is still open', { timeout: 3000 }, async () => {
  const s = toolSetup([success('done')]);
  const upstream = new PassThrough();
  const pending = s.handler.handle({}, s.res, { ok: true, status: 200, body: upstream });
  try {
    upstream.write(frame({ content: bodyTool }));
    upstream.write(frame({ content: '\r\nuser\r\n\r\n<' }));
    assert.equal(streamedText(s.res.output), bodyTool);
    upstream.write(frame({ content: echoedResultHeader.slice(1) + '\n' + echoedResultText }));
    assert.equal(upstream.destroyed, true);
    const result = await pending;
    assert.equal(result.completed, true);
    assert.equal(s.stats.executed, 1);
    assert.equal(s.controller.signal.aborted, false);
    assert.doesNotMatch(streamedText(s.res.output), /VCP_TOOL_PAYLOAD|synthetic assistant echo/);
  } finally {
    upstream.destroy();
    await pending;
  }
});