const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { VcpCoreEngine, ChatChunkType } = require('../core');
const IpcAdapter = require('../adapters/IpcAdapter');

function createMockSseResponse(items) {
  const body = new PassThrough();
  setImmediate(() => {
    for (const item of items) {
      if (item && item.done) {
        body.write('data: [DONE]\n\n');
      } else {
        body.write(`data: ${JSON.stringify(item)}\n\n`);
      }
    }
    body.end();
  });
  return {
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'text/event-stream']]),
    body,
    text: async () => ''
  };
}

test('IpcAdapter: 全双工管道 Ping-Pong、流式传输与主动唤醒端到端验证', async () => {
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\vcp-ipc-test-${Date.now()}`
    : `/tmp/vcp-ipc-test-${Date.now()}.sock`;

  const mockChunks = [
    { choices: [{ delta: { content: 'IPC通信' } }] },
    { choices: [{ delta: { content: '极速直连！' } }] },
    { done: true }
  ];

  const engine = new VcpCoreEngine({
    fetchImpl: async () => createMockSseResponse(mockChunks)
  });

  const adapter = new IpcAdapter(engine, { pipePath });
  await adapter.start();

  // 创建客户端连接
  const client = net.connect(pipePath);
  const receivedMessages = [];

  let buffer = '';
  client.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        receivedMessages.push(JSON.parse(line.trim()));
      }
    }
  });

  await new Promise(r => client.on('connect', r));

  // 1. 测试 Ping-Pong
  client.write(JSON.stringify({ type: 'ping' }) + '\n');
  await new Promise(r => setTimeout(r, 50));
  const pongMsg = receivedMessages.find(m => m.type === 'pong');
  assert.ok(pongMsg);
  assert.ok(pongMsg.timestamp > 0);

  // 2. 测试 chat:start 流式传输
  const reqId = 'ipc-test-1';
  client.write(JSON.stringify({
    type: 'chat:start',
    requestId: reqId,
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }]
  }) + '\n');

  // 等待流结束
  const startWait = Date.now();
  while (!receivedMessages.some(m => m.type === 'chat:chunk' && m.chunk?.type === ChatChunkType.DONE) && Date.now() - startWait < 2000) {
    await new Promise(r => setTimeout(r, 50));
  }

  const chunkMessages = receivedMessages.filter(m => m.type === 'chat:chunk' && m.requestId === reqId);
  assert.ok(chunkMessages.length >= 3);
  const deltaTexts = chunkMessages
    .filter(m => m.chunk?.type === ChatChunkType.DELTA)
    .map(m => m.chunk?.text)
    .join('');
  assert.equal(deltaTexts, 'IPC通信极速直连！');

  // 3. 测试主动唤醒广播
  engine.wakeFrontend({
    title: '智能体主动唤醒',
    content: '后台思考任务已完成',
    level: 'urgent_popup'
  });

  await new Promise(r => setTimeout(r, 50));
  const wakeMsg = receivedMessages.find(m => m.type === 'proactive:wake');
  assert.ok(wakeMsg);
  assert.equal(wakeMsg.event?.title, '智能体主动唤醒');
  assert.equal(wakeMsg.event?.level, 'urgent_popup');

  // 4. 清理断开
  client.end();
  await adapter.stop();
});
