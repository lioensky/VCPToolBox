const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

function listen(target) {
  return new Promise((resolve, reject) => {
    const server = target.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => resolve({ server, port: server.address().port }));
  });
}

async function close(server) {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function parseSseEvents(text) {
  return text
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const event = block.match(/^event:([^\n]+)$/m)?.[1]?.trim();
      const dataLine = block.match(/^data:\s*([^\n]+)$/m)?.[1];
      return { event, data: dataLine ? JSON.parse(dataLine) : null };
    });
}

function createBridgeApp() {
  delete require.cache[require.resolve('../routes/protocolBridge')];
  const app = express();
  app.use(express.json());
  app.use(require('../routes/protocolBridge'));
  return app;
}

test('Responses function calls bridge JSON and continuation messages', async t => {
  const upstreamBodies = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => {
    upstreamBodies.push(req.body);
    const hasToolResult = req.body.messages.some(message => message.role === 'tool');
    if (hasToolResult) {
      return res.json({
        id: 'chatcmpl-final',
        model: req.body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'The weather is sunny.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      });
    }
    return res.json({
      id: 'chatcmpl-tool',
      model: req.body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_weather_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
    });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);

  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const functionTool = {
    type: 'function',
    name: 'get_weather',
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  };
  const first = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: 'SYSTEM {{VCPAllTools}} {{AgentFoo}}',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather?' }] }],
    tools: [functionTool],
    tool_choice: 'auto'
  });

  assert.equal(first.response.status, 200);
  assert.equal(first.body.output[0].type, 'function_call');
  assert.equal(first.body.output[0].call_id, 'call_weather_1');
  assert.equal(first.body.output[0].name, 'get_weather');
  assert.equal(first.body.output[0].arguments, '{"city":"Shanghai"}');
  assert.equal(upstreamBodies[0].tools[0].function.name, 'get_weather');
  assert.equal(upstreamBodies[0].tool_choice, 'auto');
  assert.deepEqual(upstreamBodies[0].messages[0], {
    role: 'system',
    content: 'SYSTEM {{VCPAllTools}} {{AgentFoo}}'
  });
  assert.deepEqual(upstreamBodies[0].messages[1], {
    role: 'user',
    content: 'What is the weather?'
  });

  const second = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: 'SYSTEM {{VCPAllTools}} {{AgentFoo}}',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather?' }] },
      { type: 'function_call', call_id: 'call_weather_1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temperature":25,"condition":"sunny"}' }
    ]
  });

  assert.equal(second.body.output_text, 'The weather is sunny.');
  const continuation = upstreamBodies[1].messages;
  assert.deepEqual(continuation[0], {
    role: 'system',
    content: 'SYSTEM {{VCPAllTools}} {{AgentFoo}}'
  });
  assert.deepEqual(continuation[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_weather_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }]
  });
  assert.deepEqual(continuation[3], {
    role: 'tool',
    tool_call_id: 'call_weather_1',
    content: '{"temperature":25,"condition":"sunny"}'
  });
});

test('Responses instructions precede string and array input without colliding stable request ids', async t => {
  const upstreamBodies = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => {
    upstreamBodies.push(req.body);
    res.json({
      id: `chatcmpl-${upstreamBodies.length}`,
      model: req.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);

  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const first = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: 'SYSTEM A {{VCPAllTools}}',
    input: 'hello'
  });
  const second = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: 'SYSTEM B {{VCPAllTools}}',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'input developer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
    ]
  });
  const duplicate = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: 'SYSTEM B {{VCPAllTools}}',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'input developer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
    ]
  });
  const emptyInstructions = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: '',
    input: 'empty instructions'
  });
  const nullInstructions = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    instructions: null,
    input: 'null instructions'
  });

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(duplicate.response.status, 200);
  assert.equal(emptyInstructions.response.status, 200);
  assert.equal(nullInstructions.response.status, 200);
  assert.equal(upstreamBodies.length, 4, 'same request is suppressed, different instructions are forwarded');
  assert.deepEqual(upstreamBodies[0].messages, [
    { role: 'system', content: 'SYSTEM A {{VCPAllTools}}' },
    { role: 'user', content: 'hello' }
  ]);
  assert.deepEqual(upstreamBodies[1].messages, [
    { role: 'system', content: 'SYSTEM B {{VCPAllTools}}' },
    { role: 'system', content: 'input developer' },
    { role: 'user', content: 'hello' }
  ]);
  assert.deepEqual(upstreamBodies[2].messages, [
    { role: 'user', content: 'empty instructions' }
  ]);
  assert.deepEqual(upstreamBodies[3].messages, [
    { role: 'user', content: 'null instructions' }
  ]);
  assert.notEqual(upstreamBodies[0].messageId, upstreamBodies[1].messageId);
  assert.match(duplicate.body.output_text, /重复提交同一 Responses 请求/);
});

test('Responses stream emits text and multiple function-call events', async t => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') return res.end();
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'test-model', choices: [{ index: 0, delta: { content: 'Checking ', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"' } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'test-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'lookup_backup', arguments: '{"q":"backup' } }, { index: 0, function: { arguments: 'hello"}' } } ] }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const response = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      instructions: 'SYSTEM {{VCPDynamicTools}}',
      input: 'lookup'
    })
  });
  const events = parseSseEvents(await response.text());
  const completed = events.find(event => event.event === 'response.completed');
  const output = completed.data.response.output;
  const outputItems = output.filter(item => item.type === 'function_call');

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamBodies[0].messages[0], {
    role: 'system',
    content: 'SYSTEM {{VCPDynamicTools}}'
  });
  assert.deepEqual(upstreamBodies[0].messages[1], {
    role: 'user',
    content: 'lookup'
  });
  assert.ok(events.some(event => event.event === 'response.function_call_arguments.delta'));
  assert.ok(events.some(event => event.event === 'response.function_call_arguments.done'));
  assert.equal(output.find(item => item.type === 'message').content[0].text, 'Checking ');
  assert.deepEqual(outputItems.map(item => [item.call_id, item.name, item.arguments]), [
    ['call_1', 'lookup', '{"q":"hello"}'],
    ['call_2', 'lookup_backup', '{"q":"backup']
  ]);
});


test('Responses non-streaming reasoning stays native and precedes visible output and tool calls', async t => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => res.json({
    id: 'chatcmpl-reasoning',
    model: req.body.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        reasoning_content: 'same reasoning',
        reasoning: 'same reasoning',
        thinking: 'same reasoning',
        reasoning_details: [{ type: 'reasoning.encrypted_content', data: 'opaque-token' }],
        content: 'Visible answer',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 8,
      total_tokens: 11,
      completion_tokens_details: { reasoning_tokens: 5 }
    }
  }));
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const result = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'reasoning-model',
    messageId: 'reasoning-non-stream-1',
    input: 'hello'
  });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.deepEqual(result.body.output[0].summary, [{ type: 'summary_text', text: 'same reasoning' }]);
  assert.equal(result.body.output[0].encrypted_content, 'opaque-token');
  assert.equal(result.body.output[1].content[0].text, 'Visible answer');
  assert.equal(result.body.output[2].call_id, 'call_1');
  assert.equal(result.body.output_text, 'Visible answer');
  assert.doesNotMatch(result.body.output_text, /same reasoning/);
  assert.equal(result.body.usage.output_tokens_details.reasoning_tokens, 5);
});

test('Responses streaming reasoning emits summary events before text and function calls', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') return res.end();
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = [
        { choices: [{ index: 0, delta: { reasoning_content: 'first ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { reasoning_content: 'thought', content: 'Visible ' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_stream', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }], usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 } }
      ];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const response = await fetch(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'reasoning-stream-model', messageId: 'reasoning-stream-1', stream: true, input: 'hello' })
  });
  const events = parseSseEvents(await response.text());
  const completed = events.find(event => event.event === 'response.completed');
  const output = completed.data.response.output;
  const reasoningIndex = output.findIndex(item => item.type === 'reasoning');
  const messageIndex = output.findIndex(item => item.type === 'message');
  const functionIndex = output.findIndex(item => item.type === 'function_call');

  assert.equal(response.status, 200);
  assert.ok(events.some(event => event.event === 'response.output_item.added' && event.data.item.type === 'reasoning'));
  assert.ok(events.some(event => event.event === 'response.reasoning_summary_part.added'));
  assert.ok(events.some(event => event.event === 'response.reasoning_summary_text.delta' && event.data.delta === 'first '));
  assert.ok(events.some(event => event.event === 'response.reasoning_summary_text.done' && event.data.text === 'first thought'));
  assert.ok(events.some(event => event.event === 'response.reasoning_summary_part.done'));
  assert.ok(events.some(event => event.event === 'response.output_item.done' && event.data.item.type === 'reasoning'));
  assert.equal(events.some(event => event.event === 'response.output_text.delta' && /first|thought/.test(event.data.delta)), false);
  assert.ok(reasoningIndex >= 0 && reasoningIndex < messageIndex && messageIndex < functionIndex);
  assert.equal(output[reasoningIndex].summary[0].text, 'first thought');
  assert.equal(output[messageIndex].content[0].text, 'Visible answer');
  assert.equal(output[functionIndex].arguments, '{}');
});

test('Responses reasoning continuation preserves reasoning fields beside assistant tool calls', async t => {
  let forwarded;
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => {
    forwarded = req.body;
    res.json({
      id: 'chatcmpl-continuation',
      model: req.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
    });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const result = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'reasoning-continuation-model',
    messageId: 'reasoning-continuation-1',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use tool' }] },
      {
        type: 'reasoning',
        id: 'rs_123',
        summary: [{ type: 'summary_text', text: 'Previous reasoning summary' }],
        encrypted_content: 'opaque-continuation-token'
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'tool result' }
    ]
  });

  assert.equal(result.response.status, 200);
  const assistant = forwarded.messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant, {
    role: 'assistant',
    content: null,
    reasoning_content: 'Previous reasoning summary',
    reasoning_details: [{ type: 'reasoning.encrypted_content', data: 'opaque-continuation-token' }],
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
  });
  assert.equal(forwarded.messages.find(message => message.role === 'tool').content, 'tool result');
});

test('Responses input reasoning without encrypted content does not create empty details', async t => {
  let forwarded;
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => {
    forwarded = req.body;
    res.json({ id: 'chatcmpl-summary-only', model: req.body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'reasoning-summary-only-model',
    messageId: 'reasoning-summary-only-1',
    input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary only' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
  });

  const reasoningMessage = forwarded.messages.find(message => message.role === 'assistant');
  assert.equal(reasoningMessage.reasoning_content, 'summary only');
  assert.equal(Object.hasOwn(reasoningMessage, 'reasoning_details'), false);
  assert.equal(Object.hasOwn(reasoningMessage, 'content'), true);
});


test('Responses does not create native reasoning for ordinary think-tag content', async t => {
  const upstream = express();
  upstream.use(express.json());
  upstream.post('/v1/chat/completions', (req, res) => res.json({
    id: 'chatcmpl-think-content',
    model: req.body.model,
    choices: [{ message: { role: 'assistant', content: '<think>already visible</think>answer' }, finish_reason: 'stop' }]
  }));
  const upstreamInfo = await listen(upstream);
  process.env.PORT = String(upstreamInfo.port);
  const bridgeInfo = await listen(http.createServer(createBridgeApp()));
  t.after(async () => {
    await close(bridgeInfo.server);
    await close(upstreamInfo.server);
  });

  const result = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'think-content-model',
    messageId: 'think-content-1',
    input: 'hello'
  });

  assert.deepEqual(result.body.output.map(item => item.type), ['message']);
  assert.equal(result.body.output_text, '<think>already visible</think>answer');
});
