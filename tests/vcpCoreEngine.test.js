const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  VcpCoreEngine,
  ChatChunkType,
  WakeLevel,
  DaemonLifecycleState,
  ShutdownReason,
  StreamEventSink,
  createWakeEvent
} = require('../core');

/**
 * 构造模拟的 SSE 流式响应
 * @param {Array<object|string>} items
 * @returns {object} Response 模拟对象
 */
function createMockSseResponse(items) {
  const body = new PassThrough();
  setImmediate(() => {
    for (const item of items) {
      if (typeof item === 'string') {
        body.write(item + '\n');
      } else if (item && item.done) {
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

test('VcpCoreEngine 基础初始化与生命周期状态流转', async () => {
  const engine = new VcpCoreEngine({
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: 'mock-key'
  });

  assert.equal(engine.getState(), DaemonLifecycleState.RUNNING);

  const stateChanges = [];
  engine.on('lifecycle:change', change => stateChanges.push(change));

  // 模拟生命周期流转到打盹
  engine.setState(DaemonLifecycleState.SLEEPING, 'VCPSleep plugin active');
  assert.equal(engine.getState(), DaemonLifecycleState.SLEEPING);
  assert.equal(stateChanges.length, 1);
  assert.equal(stateChanges[0].current, DaemonLifecycleState.SLEEPING);
  assert.equal(stateChanges[0].reason, 'VCPSleep plugin active');

  // 优雅关机
  let shutdownDoneEmitted = false;
  engine.on('shutdown:done', () => { shutdownDoneEmitted = true; });

  await engine.shutdown(ShutdownReason.USER_QUIT, 500);
  assert.equal(engine.getState(), DaemonLifecycleState.SHUTDOWN);
  assert.equal(shutdownDoneEmitted, true);
});

test('Proactive Wakeup Protocol: 主动唤醒协议事件派发与结构完整性', () => {
  const engine = new VcpCoreEngine();
  const wakeEvents = [];

  engine.on('proactive:wake', event => wakeEvents.push(event));

  // 1. 默认参数强弹唤醒
  const wake1 = engine.wakeFrontend({
    title: '智能体主动唤醒',
    content: '用户您好，后台任务已处理完毕！',
    level: WakeLevel.URGENT_POPUP,
    audioTts: true,
    actions: [{ label: '查看', action: 'open_report' }]
  });

  assert.equal(wakeEvents.length, 1);
  assert.equal(wake1.type, 'proactive:wake');
  assert.equal(wake1.level, WakeLevel.URGENT_POPUP);
  assert.equal(wake1.title, '智能体主动唤醒');
  assert.equal(wake1.content, '用户您好，后台任务已处理完毕！');
  assert.equal(wake1.audioTts, true);
  assert.equal(wake1.actions.length, 1);
  assert.ok(wake1.timestamp > 0);
  assert.ok(wake1.id.startsWith('wake-'));

  // 2. 自定义低级别唤醒 (桌面横幅)
  const wake2 = engine.emitProactiveWake({
    level: WakeLevel.TOAST,
    title: '后台打盹',
    content: '正在整理记忆索引...'
  });

  assert.equal(wakeEvents.length, 2);
  assert.equal(wake2.level, WakeLevel.TOAST);
});

test('Pure Context Preparation: 剔除私有字段与保持上下文纯净', async () => {
  const engine = new VcpCoreEngine({
    modelRedirectHandler: { redirectModelForBackend: m => m === 'alias-model' ? 'real-model' : m }
  });

  const rawReq = {
    id: 'req-123',
    model: 'alias-model',
    messages: [
      { role: 'system', content: 'You are an AI companion.' },
      { role: 'user', content: 'Hello VCP!' }
    ],
    vcpchatExtensions: { messageTimestampBindings: [123456] },
    contextTokenLimit: 4096
  };

  const contextPlan = await engine.prepareContext(rawReq);
  const upstreamBody = contextPlan.finalUpstreamBody;

  // 验证模型已重定向
  assert.equal(upstreamBody.model, 'real-model');
  // 验证 vcpchatExtensions 和 contextTokenLimit 已被剔除
  assert.equal(upstreamBody.vcpchatExtensions, undefined);
  assert.equal(upstreamBody.contextTokenLimit, undefined);
  // 验证消息结构完整
  assert.equal(upstreamBody.messages.length, 2);
  assert.equal(upstreamBody.messages[1].content, 'Hello VCP!');
});

test('chatStream: 异步流式生成器产出 delta、reasoning 与 done 事件', async () => {
  // 构造模拟上游响应：思维链 + 正文增量 + 结束
  const mockChunks = [
    { choices: [{ delta: { reasoning_content: '思考中：' } }] },
    { choices: [{ delta: { reasoning_content: '用户在打招呼\n' } }] },
    { choices: [{ delta: { content: '你好！' } }] },
    { choices: [{ delta: { content: '我是 VCP。' } }] },
    { done: true }
  ];

  const engine = new VcpCoreEngine({
    fetchImpl: async () => createMockSseResponse(mockChunks)
  });

  const yieldedChunks = [];
  for await (const chunk of engine.chatStream({
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }]
  })) {
    yieldedChunks.push(chunk);
  }

  // 检验产出的事件序列
  const reasoningChunks = yieldedChunks.filter(c => c.type === ChatChunkType.REASONING);
  const deltaChunks = yieldedChunks.filter(c => c.type === ChatChunkType.DELTA);
  const doneChunks = yieldedChunks.filter(c => c.type === ChatChunkType.DONE);

  assert.equal(reasoningChunks.length, 2);
  assert.equal(reasoningChunks[0].reasoning, '思考中：');
  assert.equal(reasoningChunks[1].reasoning, '用户在打招呼\n');

  assert.equal(deltaChunks.length, 2);
  assert.equal(deltaChunks[0].text, '你好！');
  assert.equal(deltaChunks[1].text, '我是 VCP。');

  assert.equal(doneChunks.length, 1);
  assert.equal(doneChunks[0].finish_reason, 'stop');
  assert.equal(doneChunks[0].content, '你好！我是 VCP。');
  assert.equal(doneChunks[0].reasoning, '思考中：用户在打招呼\n');
});

test('chatStream: AbortController 取消与中途中止机制', async () => {
  const body = new PassThrough();
  const abortController = new AbortController();

  const mockResponse = {
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'text/event-stream']]),
    body,
    text: async () => ''
  };

  const engine = new VcpCoreEngine({
    fetchImpl: async () => mockResponse
  });

  // 先推入第一个 chunk
  body.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '开始回答...' } }] })}\n\n`);

  const yieldedChunks = [];
  const streamPromise = (async () => {
    for await (const chunk of engine.chatStream({
      id: 'abort-test-req',
      model: 'test-model',
      messages: [{ role: 'user', content: '长任务' }],
      signal: abortController.signal
    })) {
      yieldedChunks.push(chunk);
      if (chunk.type === ChatChunkType.DELTA) {
        // 收到第一个 chunk 后立即中止
        abortController.abort();
      }
    }
  })();

  await streamPromise;

  const hasDelta = yieldedChunks.some(c => c.type === ChatChunkType.DELTA);
  const hasAborted = yieldedChunks.some(c => c.type === ChatChunkType.ABORTED);

  assert.equal(hasDelta, true);
  assert.equal(hasAborted, true);
});

test('chatStream: 递归工具调用循环 (Tool Calling Loop)', async () => {
  let callCount = 0;
  const toolExecutions = [];

  const mockToolExecutor = {
    execute: async (toolCall, clientIp, messages) => {
      toolExecutions.push(toolCall);
      return { status: 'success', temperature: '22°C', city: '北京' };
    }
  };

  const mockToolCallParser = {
    parse: text => {
      if (text.includes('[[VCPToolUse:Weather]]')) {
        return [{ name: 'Weather', args: { city: '北京' } }];
      }
      return [];
    }
  };

  const engine = new VcpCoreEngine({
    toolExecutor: mockToolExecutor,
    ToolCallParser: mockToolCallParser,
    fetchImpl: async () => {
      callCount++;
      if (callCount === 1) {
        // 第一轮：触发工具调用
        return createMockSseResponse([
          { choices: [{ delta: { content: '正在查询天气：[[VCPToolUse:Weather]]' } }] },
          { done: true }
        ]);
      } else {
        // 第二轮：获得工具结果后的最终回答
        return createMockSseResponse([
          { choices: [{ delta: { content: '北京今天气温为 22°C，体感舒适。' } }] },
          { done: true }
        ]);
      }
    }
  });

  const yielded = [];
  for await (const chunk of engine.chatStream({
    model: 'test-model',
    messages: [{ role: 'user', content: '查一下北京天气' }]
  })) {
    yielded.push(chunk);
  }

  // 验证两轮上游调用
  assert.equal(callCount, 2);
  // 验证工具被执行
  assert.equal(toolExecutions.length, 1);
  assert.equal(toolExecutions[0].name, 'Weather');

  // 验证事件流依次产出了：DELTA -> TOOL_CALL -> TOOL_RESULT -> LOOP_CONTINUE -> DELTA -> DONE
  const eventTypes = yielded.map(c => c.type);
  assert.ok(eventTypes.includes(ChatChunkType.TOOL_CALL));
  assert.ok(eventTypes.includes(ChatChunkType.TOOL_RESULT));
  assert.ok(eventTypes.includes(ChatChunkType.LOOP_CONTINUE));
  assert.ok(eventTypes.includes(ChatChunkType.DONE));

  const finalDone = yielded.find(c => c.type === ChatChunkType.DONE);
  assert.ok(finalDone.content.includes('22°C'));
});

test('chat 非流式包装器与 pipeChatStream Sink 适配器', async () => {
  const mockChunks = [
    { choices: [{ delta: { content: '六边形' } }] },
    { choices: [{ delta: { content: '架构测试' } }] },
    { done: true }
  ];

  const engine = new VcpCoreEngine({
    fetchImpl: async () => createMockSseResponse(mockChunks)
  });

  // 1. 测试 chat() 非流式直接返回结果
  const result = await engine.chat({
    model: 'test-model',
    messages: [{ role: 'user', content: '测试' }]
  });

  assert.equal(result.choices[0].message.content, '六边形架构测试');
  assert.equal(result.choices[0].finish_reason, 'stop');

  // 2. 测试 pipeChatStream() 写入自定义 Sink
  class CaptureSink extends StreamEventSink {
    constructor() {
      super();
      this.chunks = [];
      this.ended = false;
    }
    writeChunk(chunk) { this.chunks.push(chunk); }
    end() { this.ended = true; }
    error(err) { throw err; }
  }

  const sink = new CaptureSink();
  await engine.pipeChatStream({
    model: 'test-model',
    messages: [{ role: 'user', content: '测试' }]
  }, sink);

  assert.equal(sink.ended, true);
  assert.ok(sink.chunks.length >= 3);
  const textAccumulated = sink.chunks
    .filter(c => c.type === ChatChunkType.DELTA)
    .map(c => c.text)
    .join('');
  assert.equal(textAccumulated, '六边形架构测试');
});
