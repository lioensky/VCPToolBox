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

  const second = await requestJson(`http://127.0.0.1:${bridgeInfo.port}/v1/responses`, {
    model: 'test-model',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather?' }] },
      { type: 'function_call', call_id: 'call_weather_1', name: 'get_weather', arguments: '{"city":"Shanghai"}' },
      { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temperature":25,"condition":"sunny"}' }
    ]
  });

  assert.equal(second.body.output_text, 'The weather is sunny.');
  const continuation = upstreamBodies[1].messages;
  assert.deepEqual(continuation[1], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_weather_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }]
  });
  assert.deepEqual(continuation[2], {
    role: 'tool',
    tool_call_id: 'call_weather_1',
    content: '{"temperature":25,"condition":"sunny"}'
  });
});

test('Responses stream emits text and multiple function-call events', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') return res.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'test-model', choices: [{ index: 0, delta: { content: 'Checking ', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"' } }] }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'test-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'lookup_backup', arguments: '{"q":"backup' } }, { index: 0, function: { arguments: 'hello"}' } } ] }, finish_reason: 'tool_calls' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
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
    body: JSON.stringify({ model: 'test-model', stream: true, input: 'lookup' })
  });
  const events = parseSseEvents(await response.text());
  const completed = events.find(event => event.event === 'response.completed');
  const output = completed.data.response.output;
  const outputItems = output.filter(item => item.type === 'function_call');

  assert.equal(response.status, 200);
  assert.ok(events.some(event => event.event === 'response.function_call_arguments.delta'));
  assert.ok(events.some(event => event.event === 'response.function_call_arguments.done'));
  assert.equal(output.find(item => item.type === 'message').content[0].text, 'Checking ');
  assert.deepEqual(outputItems.map(item => [item.call_id, item.name, item.arguments]), [
    ['call_1', 'lookup', '{"q":"hello"}'],
    ['call_2', 'lookup_backup', '{"q":"backup']
  ]);
});
