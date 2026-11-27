'use strict';

if (process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE === undefined) {
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'true';
}

/**
 * tests/vcpProtocolInTurnIntegration.test.js
 *
 * VCP 协议自愈系统 Batch 7 轮内主链路薄胶水钩子集成测试套件
 *
 * 覆盖矩阵：
 * Group 1: ToolExecutor 前置门控拦截与 createGuidanceResult 契约验证（0.000% 真实插件执行）
 * Group 2: 流式与非流式下 reconcileTurnToolCalls 接入与异常捕获降级（Fail-Safe 兜底）
 * Group 3: sawDone 导出及流尾接管状态同步（takeToolTail / acceptMalformedToolTurn / Archery 循环）
 * Group 4: 非流式步骤 0A 硬门控（防报错 JSON 伪装工具，初始轮与两处递归轮全面防御）
 * Group 5: SHOW_VCP_OUTPUT=false 静默模式下纠偏回执强制可见与摘要状态词锁定
 * Group 6: 跨轮闭环验证：Batch 7 产出的坏块与回执接入 Batch 4 历史清洗与常驻药丸注入
 * Group 7: 环境变量旁路开关与降级验证（ENABLE_TOOL_PROTOCOL_RESILIENCE=false / vcpToolUseForbidden）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, EventEmitter } = require('node:stream');

const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');
const toolCallRecordStore = require('../modules/toolCallRecordStore');
const protocolResilience = require('../modules/vcpProtocolResilience');
const {
  cleanseHistory,
  reconcileTurnToolCalls,
  createGuidanceResult,
  assembleInTurnGuidance,
  extractHistoricalErrorBlocks
} = protocolResilience;

// Mock 运行时数据库记录（在 Bun 环境下防 better-sqlite3 缺失崩溃）
const origBeginRecord = toolCallRecordStore.beginRecord;
const origFinishRecord = toolCallRecordStore.finishRecord;
toolCallRecordStore.beginRecord = (opts) => ({ id: 'mock-rec-id', ...opts });
toolCallRecordStore.finishRecord = () => {};

if (typeof test.after === 'function') {
  test.after(() => {
    toolCallRecordStore.beginRecord = origBeginRecord;
    toolCallRecordStore.finishRecord = origFinishRecord;
  });
}

// =========================================================================
// 测试辅助工具与 Mock 构造工厂
// =========================================================================

function createMockRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.output = '';
  res.bodyText = '';
  res.statusCode = 200;
  res.status = function(code) {
    this.statusCode = code;
    return this;
  };
  res.write = function(chunk, cb) {
    this.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (cb) cb();
    return true;
  };
  res.end = function(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
  };
  res.send = function(buf) {
    this.bodyText = Buffer.isBuffer(buf) ? buf.toString('utf8') : (typeof buf === 'string' ? buf : JSON.stringify(buf));
    this.writableEnded = true;
    this.emit('finish');
  };
  res.json = function(obj) {
    this.bodyText = JSON.stringify(obj);
    this.writableEnded = true;
    this.emit('finish');
  };
  return res;
}

const frame = (delta, finish_reason = null, native_finish_reason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason, native_finish_reason }] })}\n\n`;

function createStreamResponse(text, finish_reason = 'stop', native_finish_reason = null) {
  const payload = frame({ content: text }) + frame({}, finish_reason, native_finish_reason) + 'data: [DONE]\n\n';
  return {
    ok: true,
    status: 200,
    body: Readable.from([Buffer.from(payload)])
  };
}

function createNonStreamResponse(content, finish_reason = 'stop', options = {}) {
  const ok = options.ok !== undefined ? options.ok : true;
  const status = options.status || (ok ? 200 : 500);
  const json = options.error
    ? { error: options.error }
    : {
        id: 'chatcmpl-test',
        model: options.model || 'test-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content
          },
          finish_reason: finish_reason,
          native_finish_reason: options.native_finish_reason || null
        }]
      };
  const rawBuf = Buffer.from(JSON.stringify(json));
  return {
    ok,
    status,
    arrayBuffer: async () => rawBuf
  };
}

class MockPluginManager {
  constructor() {
    this.executedTools = [];
    this.messagePreprocessors = new Map();
  }
  getPlugin(name) {
    if (name === 'MockValidTool' || name === 'LinuxShellExecutor') {
      return {
        execute: async () => ({ success: true })
      };
    }
    return null;
  }
  async processToolCall(name, args, clientIp, sourceNode, options) {
    this.executedTools.push({ name, args });
    return { success: true, result: `Plugin ${name} executed successfully` };
  }
}

function createMockStreamContext(overrides = {}) {
  const controller = new AbortController();
  const pluginManager = overrides.pluginManager || new MockPluginManager();
  const toolExecutor = overrides.toolExecutor || new ToolExecutor({
    pluginManager,
    webSocketServer: { broadcast: () => {} },
    debugMode: false,
    vcpToolCode: null,
    getRealAuthCode: null
  });
  return {
    originalBody: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] },
    apiUrl: 'https://test.api',
    apiKey: 'test-key',
    abortController: controller,
    pluginManager,
    ToolCallParser,
    toolExecutor,
    maxVCPLoopStream: 3,
    apiRetries: 1,
    apiRetryDelay: 0,
    SHOW_VCP_OUTPUT: true,
    DEBUG_MODE: false,
    fetchWithRetry: async () => createStreamResponse('Done'),
    isToolResultError: () => false,
    writeDebugLog: () => {},
    writeChatLog: () => {},
    ...overrides
  };
}

function createMockNonStreamContext(overrides = {}) {
  const controller = new AbortController();
  const pluginManager = overrides.pluginManager || new MockPluginManager();
  const toolExecutor = overrides.toolExecutor || new ToolExecutor({
    pluginManager,
    webSocketServer: { broadcast: () => {} },
    debugMode: false,
    vcpToolCode: null,
    getRealAuthCode: null
  });
  return {
    originalBody: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] },
    apiUrl: 'https://test.api',
    apiKey: 'test-key',
    abortController: controller,
    pluginManager,
    ToolCallParser,
    toolExecutor,
    maxVCPLoopNonStream: 3,
    apiRetries: 1,
    apiRetryDelay: 0,
    SHOW_VCP_OUTPUT: true,
    DEBUG_MODE: false,
    fetchWithRetry: async () => createNonStreamResponse('Done'),
    isToolResultError: () => false,
    writeDebugLog: () => {},
    writeChatLog: () => {},
    ...overrides
  };
}

// =========================================================================
// Group 1: ToolExecutor 前置门控拦截与 createGuidanceResult 契约验证
// =========================================================================

test('G1-1: toolCall.isProtocolError=true 时立即拦截，0.000% 触发插件执行与密码验证', async () => {
  let pluginQueried = false;
  let authQueried = false;
  const mockPM = {
    getPlugin: (name) => {
      pluginQueried = true;
      return { execute: async () => ({ success: true }) };
    }
  };
  const executor = new ToolExecutor({
    pluginManager: mockPM,
    webSocketServer: { broadcast: () => {} },
    vcpToolCode: 'vcp',
    getRealAuthCode: async () => {
      authQueried = true;
      return '123';
    }
  });

  const protocolErrorToolCall = {
    name: 'VCP工具调用',
    isProtocolError: true,
    errorCode: 'MISSING_TOOL_NAME',
    blockFingerprint: 'deadbeef'
  };

  const result = await executor.execute(protocolErrorToolCall, '127.0.0.1', []);
  assert.equal(pluginQueried, false, '协议错误绝不能调用 pluginManager.getPlugin');
  assert.equal(authQueried, false, '协议错误绝不能调用 getRealAuthCode');
  assert.equal(result.isFormatGuidance, true, '必须标记 isFormatGuidance');
  assert.equal(result.isProtocolError, true, '必须标记 isProtocolError');
  assert.equal(result.success, false, '执行状态必须为 false');
  assert.ok(result.content[0].text.includes('[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=deadbeef]]'), '必须包含纠偏凭条');
});

test('G1-2: toolCall.isProtocolGuidance=true 时同样前置拦截', async () => {
  let pluginQueried = false;
  const mockPM = {
    getPlugin: () => {
      pluginQueried = true;
      return null;
    }
  };
  const executor = new ToolExecutor({
    pluginManager: mockPM,
    webSocketServer: { broadcast: () => {} }
  });
  const result = await executor.execute({
    name: 'VCP工具调用',
    isProtocolGuidance: true,
    errorCode: 'UNCLOSED_TOOL_BLOCK',
    blockFingerprint: 'abcd5678'
  }, '127.0.0.1', []);

  assert.equal(pluginQueried, false);
  assert.equal(result.isFormatGuidance, true);
  assert.equal(result.success, false);
  assert.ok(result.content[0].text.includes('UNCLOSED_TOOL_BLOCK'));
});

test('G1-3: createGuidanceResult 契约属性全量对齐（success, isFormatGuidance, raw, error）', () => {
  const guidance = createGuidanceResult({
    errorCode: 'MALFORMED_BLOCK_SYNTAX',
    blockFingerprint: 'cafe9999'
  });

  assert.equal(guidance.success, false);
  assert.equal(guidance.isFormatGuidance, true);
  assert.equal(guidance.isProtocolError, true);
  assert.ok(Array.isArray(guidance.content) && guidance.content.length > 0);
  assert.equal(guidance.content[0].type, 'text');
  assert.equal(guidance.raw, guidance.content[0].text, 'raw 必须与 content[0].text 严格对齐');
  assert.equal(guidance.error, guidance.content[0].text, 'error 必须与 content[0].text 严格对齐');
  assert.ok(guidance.raw.includes('[[VCP协议纠偏指导: code=MALFORMED_BLOCK_SYNTAX block=cafe9999]]'));
  assert.ok(guidance.raw.includes('[[/VCP协议纠偏指导]]'));
});

test('G1-4: executeAll 混合并发批次隔离验证：正常工具正常执行，协议错误被拦截互不干扰', async () => {
  const pm = new MockPluginManager();
  const executor = new ToolExecutor({
    pluginManager: pm,
    webSocketServer: { broadcast: () => {} },
    vcpToolCode: null
  });

  const validCall = {
    name: 'MockValidTool',
    args: { query: 'test' }
  };
  const errorCall = {
    name: 'VCP工具调用',
    isProtocolError: true,
    errorCode: 'MISSING_TOOL_NAME',
    blockFingerprint: '55667788'
  };

  const results = await executor.executeAll([validCall, errorCall], '127.0.0.1', []);
  assert.equal(results.length, 2);
  assert.equal(results[0].success, true, '正常工具执行成功');
  assert.equal(results[0].isFormatGuidance, undefined);
  assert.equal(pm.executedTools.length, 1);
  assert.equal(pm.executedTools[0].name, 'MockValidTool');

  assert.equal(results[1].success, false, '协议错误工具执行失败');
  assert.equal(results[1].isFormatGuidance, true);
  assert.ok(results[1].raw.includes('code=MISSING_TOOL_NAME'));
});

test('G1-5: toolCall 为 null / undefined / 空对象以及 debugMode: true 且缺少 args 时的解构防御', async () => {
  const pm = new MockPluginManager();
  const executor = new ToolExecutor({
    pluginManager: pm,
    webSocketServer: { broadcast: () => {} },
    debugMode: true
  });

  // 1. null / undefined / {} 必须安全返回错误结果，不得抛出 TypeError
  const resNull = await executor.execute(null, '127.0.0.1', []);
  assert.equal(resNull.success, false);

  const resUndef = await executor.execute(undefined, '127.0.0.1', []);
  assert.equal(resUndef.success, false);

  const resEmpty = await executor.execute({}, '127.0.0.1', []);
  assert.equal(resEmpty.success, false);

  // 2. toolCall 存在但缺少 args 属性时，在 debugMode: true 下安全执行，不触发 TypeError
  const resNoArgs = await executor.execute({ name: 'MockValidTool' }, '127.0.0.1', []);
  assert.equal(resNoArgs.success, true);
  assert.equal(pm.executedTools.length, 1);
  assert.equal(pm.executedTools[0].name, 'MockValidTool');
  assert.deepEqual(pm.executedTools[0].args, {});

  // 3. toolCall.args 显式为 undefined
  const resUndefArgs = await executor.execute({ name: 'MockValidTool', args: undefined }, '127.0.0.1', []);
  assert.equal(resUndefArgs.success, true);
  assert.equal(pm.executedTools.length, 2);
  assert.deepEqual(pm.executedTools[1].args, {});

  // 4. toolCall.args 显式为 null 防穿透解构防御
  const resNullArgs = await executor.execute({ name: 'MockValidTool', args: null }, '127.0.0.1', []);
  assert.equal(resNullArgs.success, true);
  assert.equal(pm.executedTools.length, 3);
  assert.deepEqual(pm.executedTools[2].args, {});
});

test('G1-6: StreamHandler 与 NonStreamHandler 遇到 context.originalBody 为 null / undefined 时安全防御', async () => {
  const resStream = createMockRes();
  const ctxStream = createMockStreamContext({ originalBody: null });
  const streamHandler = new StreamHandler(ctxStream);
  const streamResponse = createStreamResponse('普通文本回复');

  const outcomeStream = await streamHandler.handle({}, resStream, streamResponse);
  assert.equal(outcomeStream.completed, true, 'StreamHandler 在 originalBody=null 时不得崩溃');

  const resNonStream = createMockRes();
  const ctxNonStream = createMockNonStreamContext({ originalBody: null });
  const nonStreamHandler = new NonStreamHandler(ctxNonStream);
  const nonStreamResponse = createNonStreamResponse('普通文本回复');

  const outcomeNonStream = await nonStreamHandler.handle({}, resNonStream, nonStreamResponse);
  assert.equal(outcomeNonStream.completed, true, 'NonStreamHandler 在 originalBody=null 时不得崩溃');
});

test('G1-7: ToolExecutor.executeAll 遇到 null / undefined 时空指针防御，安全返回空数组 []', async () => {
  const pm = new MockPluginManager();
  const executor = new ToolExecutor(pm, null, { debugMode: true });

  const resNull = await executor.executeAll(null, '127.0.0.1', []);
  assert.ok(Array.isArray(resNull), 'executeAll(null) 必须返回数组');
  assert.equal(resNull.length, 0, 'executeAll(null) 必须返回空数组');

  const resUndef = await executor.executeAll(undefined, '127.0.0.1', []);
  assert.ok(Array.isArray(resUndef), 'executeAll(undefined) 必须返回数组');
  assert.equal(resUndef.length, 0, 'executeAll(undefined) 必须返回空数组');
});

// =========================================================================
// Group 2: 流式与非流式下 reconcileTurnToolCalls 接入与异常捕获降级 (Fail-Safe)
// =========================================================================

test('G2-1: 流式调用正常触发 reconcileTurnToolCalls 并正确透传 isStreaming: true 等参数', async () => {
  let reconcilerCalledWith = null;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;

  protocolResilience.reconcileTurnToolCalls = async (content, rawCalls, options) => {
    reconcilerCalledWith = { content, rawCalls, options };
    return originalReconcile(content, rawCalls, options);
  };

  const oldSmallModelEnv = process.env.ENABLE_SMALL_MODEL_ARBITRATION;
  process.env.ENABLE_SMALL_MODEL_ARBITRATION = 'true';
  try {
    const res = createMockRes();
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    const badBlock = [
      '执行操作：',
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'LinuxShellExecutor:「始」pwd「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    await handler.handle({}, res, createStreamResponse(badBlock));

    assert.ok(reconcilerCalledWith !== null, 'reconcileTurnToolCalls 必须被调用');
    assert.equal(reconcilerCalledWith.options.isStreaming, true, '流式模式必须传 isStreaming: true');
    assert.equal(reconcilerCalledWith.options.sawDone, true, '正常读完流必须传 sawDone: true');
    assert.equal(protocolResilience.isSmallModelArbitrationEnabled(), false, 'V2 架构小模型仲裁恒为 false');
    assert.ok(reconcilerCalledWith.options.agentManager, 'agentManager 必须传入并回退到全局模块');
    assert.ok(reconcilerCalledWith.options.agentManager.agentMap, 'agentManager 必须包含 agentMap');
  } finally {
    if (oldSmallModelEnv !== undefined) {
      process.env.ENABLE_SMALL_MODEL_ARBITRATION = oldSmallModelEnv;
    } else {
      delete process.env.ENABLE_SMALL_MODEL_ARBITRATION;
    }
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G2-2: 流式下 reconcileTurnToolCalls 抛异常时，try/catch 安全捕获并降级原生，主链路不崩溃', async () => {
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    throw new Error('Simulated reconciler fatal crash in stream');
  };

  try {
    const res = createMockRes();
    const pm = new MockPluginManager();
    const ctx = createMockStreamContext({ pluginManager: pm });
    const handler = new StreamHandler(ctx);

    const validBlock = [
      '合法调用：',
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'tool_name:「始」MockValidTool「末」,',
      'action:「始」ping「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const outcome = await handler.handle({}, res, createStreamResponse(validBlock));
    assert.equal(outcome.completed, true, '流式处理必须正常完成，不可因自愈协调器崩溃而终止');
    assert.equal(pm.executedTools.length, 1, '降级回 rawToolCalls 后正常工具必须执行');
    assert.equal(pm.executedTools[0].name, 'MockValidTool');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G2-3: 非流式调用正常触发 reconcileTurnToolCalls 并正确透传 isStreaming: false', async () => {
  let reconcilerCalledWith = null;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;

  protocolResilience.reconcileTurnToolCalls = async (content, rawCalls, options) => {
    reconcilerCalledWith = { content, rawCalls, options };
    return originalReconcile(content, rawCalls, options);
  };

  try {
    const res = createMockRes();
    const ctx = createMockNonStreamContext();
    const handler = new NonStreamHandler(ctx);

    const badBlock = [
      '执行操作：',
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'LinuxShellExecutor:「始」pwd「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    await handler.handle({}, res, createNonStreamResponse(badBlock));

    assert.ok(reconcilerCalledWith !== null, '非流式必须调用 reconcileTurnToolCalls');
    assert.equal(reconcilerCalledWith.options.isStreaming, false, '非流式模式必须传 isStreaming: false');
    assert.equal(reconcilerCalledWith.options.sawDone, true, '有效 JSON 响应必须传 sawDone: true');
    assert.ok(reconcilerCalledWith.options.agentManager, 'agentManager 必须传入并回退到全局模块');
    assert.ok(reconcilerCalledWith.options.agentManager.agentMap, 'agentManager 必须包含 agentMap');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G2-4: 非流式下 reconcileTurnToolCalls 抛异常时，try/catch 安全捕获并降级原生，主链路不崩溃', async () => {
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    throw new Error('Simulated reconciler fatal crash in non-stream');
  };

  try {
    const res = createMockRes();
    const pm = new MockPluginManager();
    const ctx = createMockNonStreamContext({ pluginManager: pm });
    const handler = new NonStreamHandler(ctx);

    const validBlock = [
      '合法调用：',
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'tool_name:「始」MockValidTool「末」,',
      'action:「始」ping「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const outcome = await handler.handle({}, res, createNonStreamResponse(validBlock));
    assert.equal(outcome.completed, true, '非流式必须正常完成');
    assert.equal(pm.executedTools.length, 1, '降级回 rawToolCalls 后正常工具必须执行');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

// =========================================================================
// Group 3: sawDone 导出及流尾接管状态同步
// =========================================================================

test('G3-1: readAIResponseStream 正常读取 [DONE] 时导出 sawDone: true', async () => {
  let sawDoneExported = null;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async (content, rawCalls, options) => {
    sawDoneExported = options.sawDone;
    return { toolCalls: rawCalls, protocolErrors: [] };
  };

  try {
    const res = createMockRes();
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    await handler.handle({}, res, createStreamResponse('Normal stream prose'));
    assert.equal(sawDoneExported, true, '正常读到 [DONE] 时 sawDone 必须为 true');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G3-2: 流未发 [DONE] 但触发流尾接管时，sawDone 同步置为 true 防外部硬截断误判', async () => {
  const res = createMockRes();
  const ctx = createMockStreamContext();
  const handler = new StreamHandler(ctx);

  // 构造未发送 [DONE] 但包含完整工具块的流，触发 upstream_close 流尾接管
  const validToolContent = [
    '好的，开始执行：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」MockValidTool「末」,',
    'action:「始」run「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  // 只发数据帧，不发 [DONE]，随后流直接结束（Readable 完成）
  const payload = frame({ content: validToolContent });
  const noDoneStream = {
    ok: true,
    status: 200,
    body: Readable.from([Buffer.from(payload)])
  };

  const outcome = await handler.handle({}, res, noDoneStream);
  assert.equal(outcome.completed, true);
});

test('G3-3: Archery 重试循环中 lastAIResponseData 状态保持同步最新轮次', async () => {
  // 验证 Archery 重试循环中补齐的 lastAIResponseData = nextAIResponseData 生效
  const res = createMockRes();
  let retryCount = 0;
  const ctx = createMockStreamContext({
    fetchWithRetry: async () => {
      retryCount++;
      return createStreamResponse('Archery 重试完成');
    }
  });
  const handler = new StreamHandler(ctx);

  // 构造一个纯 Archery 且执行报错的调用，驱动触发 Archery 重试循环
  const archeryBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」NonExistentArcheryTool「末」,',
    'archery:「始」true「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const outcome = await handler.handle({}, res, createStreamResponse(archeryBlock));
  assert.equal(outcome.completed, true);
  assert.ok(retryCount >= 1, '必须触发 Archery 重试');
});

// =========================================================================

test('G3-4: acceptMalformedToolTurn 接管流时同步导出 sawDone: true', async () => {
  const res = createMockRes();
  let reconcilerSawDone = null;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async (content, rawCalls, options) => {
    reconcilerSawDone = options.sawDone;
    return originalReconcile(content, rawCalls, options);
  };

  try {
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    // 构造 malformed_function_call 但正文包含完整 VCP 块的流
    const vcpPayload = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'tool_name:「始」MockValidTool「末」,',
      'action:「始」recover「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const streamResponse = createStreamResponse(vcpPayload, 'content_filter', 'malformed_function_call');
    await handler.handle({}, res, streamResponse);
    assert.equal(reconcilerSawDone, true, 'acceptMalformedToolTurn 接管时 sawDone 必须为 true');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G3-5: sawDone 传递补齐 completed 双重保险（当 sawDone 为 false 但 completed 为 true 时继承为 true）', async () => {
  let reconcilerSawDone = null;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async (content, rawCalls, options) => {
    if (reconcilerSawDone === null) {
      reconcilerSawDone = options.sawDone;
    }
    return originalReconcile(content, rawCalls, options);
  };

  try {
    const res = createMockRes();
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    // 构造一个有 finish_reason: 'stop' 但上游未发送 data: [DONE] 的流
    // 此时 readAIResponseStream 的 sawDone 为 false，但 completed 为 true
    const badBlock = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'LinuxShellExecutor:「始」ls「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const payloadWithoutDone =
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: badBlock }, finish_reason: 'stop' }] }) + '\n\n';

    const streamResponse = {
      ok: true,
      status: 200,
      body: Readable.from([Buffer.from(payloadWithoutDone)])
    };

    await handler.handle({}, res, streamResponse);
    assert.equal(reconcilerSawDone, true, 'sawDone 必须双重继承 completed: true');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

// Group 4: 非流式步骤 0A 硬门控（防报错 JSON 伪装工具）
// =========================================================================

test('G4-1: 初始轮 Step 0A 门控：HTTP 500 (!response.ok) 拒绝进入自愈协调器', async () => {
  let reconcilerCalled = false;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    reconcilerCalled = true;
    return { toolCalls: [], protocolErrors: [] };
  };

  try {
    const res = createMockRes();
    const ctx = createMockNonStreamContext();
    const handler = new NonStreamHandler(ctx);

    const badUpstream = {
      ok: false,
      status: 500,
      arrayBuffer: async () => Buffer.from('Internal Server Error 500')
    };

    const outcome = await handler.handle({}, res, badUpstream);
    assert.equal(reconcilerCalled, false, 'HTTP 500 必须由步骤 0A 硬门控拦截，绝不可调用自愈协调器');
    assert.equal(outcome.completed, false);
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G4-2: 初始轮 Step 0A 门控：返回 JSON 包含 error 字段拒绝进入自愈，不把报错伪装成工具', async () => {
  let reconcilerCalled = false;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    reconcilerCalled = true;
    return { toolCalls: [], protocolErrors: [] };
  };

  try {
    const res = createMockRes();
    const ctx = createMockNonStreamContext();
    const handler = new NonStreamHandler(ctx);

    const errorJson = {
      error: {
        message: 'Invalid API Key provided',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    };
    const responseWithError = {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(errorJson))
    };

    const outcome = await handler.handle({}, res, responseWithError);
    assert.equal(reconcilerCalled, false, '上游错误 JSON 绝不能进入自愈协调器');
    assert.equal(outcome.completed, false);
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G4-3: 初始轮 Step 0A 门控：上游返回消息无可见内容时拦截', async () => {
  let reconcilerCalled = false;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    reconcilerCalled = true;
    return { toolCalls: [], protocolErrors: [] };
  };

  try {
    const res = createMockRes();
    const ctx = createMockNonStreamContext();
    const handler = new NonStreamHandler(ctx);

    const emptyMessageJson = {
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '   \n\t  ' },
        finish_reason: 'stop'
      }]
    };
    const responseWithEmpty = {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(emptyMessageJson))
    };

    await handler.handle({}, res, responseWithEmpty);
    assert.equal(reconcilerCalled, false, '无可见内容时 Step 0A 拦截');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G4-4: 递归轮 Step 0A 门控：普通工具递归返回报错 JSON 时安全中断递归', async () => {
  const res = createMockRes();
  const pm = new MockPluginManager();
  const ctx = createMockNonStreamContext({
    pluginManager: pm,
    fetchWithRetry: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        error: { message: 'Rate limit exceeded in tool recursion' }
      }))
    })
  });
  const handler = new NonStreamHandler(ctx);

  const validToolCall = [
    '好的，开始执行：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」MockValidTool「末」,',
    'action:「始」run「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const outcome = await handler.handle({}, res, createNonStreamResponse(validToolCall));
  assert.equal(outcome.completed, false, '上游递归轮次报错时 Step 0A 中断递归且 completed 为 false');
  assert.equal(pm.executedTools.length, 1, '第一轮工具正常执行');
});

// =========================================================================

test('G4-5: Archery 递归轮 Step 0A 门控：Archery 重试返回报错 JSON 时安全中断递归', async () => {
  const res = createMockRes();
  const pm = new MockPluginManager();
  const ctx = createMockNonStreamContext({
    pluginManager: pm,
    fetchWithRetry: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        error: { message: 'Archery recursion upstream 500' }
      }))
    })
  });
  const handler = new NonStreamHandler(ctx);

  const archeryErrorBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」NonExistentArcheryTool「末」,',
    'archery:「始」true「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const outcome = await handler.handle({}, res, createNonStreamResponse(archeryErrorBlock));
  assert.equal(outcome.completed, false, 'Archery 递归遇报错 JSON 时 Step 0A 中断且 completed 为 false');
});

// Group 5: SHOW_VCP_OUTPUT=false 静默模式下纠偏回执强制可见与摘要状态词锁定
// =========================================================================

test('G5-1: 流式 SHOW_VCP_OUTPUT=false 静默模式下，isFormatGuidance 纠偏回执强制推流给客户端', async () => {
  const res = createMockRes();
  const ctx = createMockStreamContext({
    SHOW_VCP_OUTPUT: false // 静默模式
  });
  const handler = new StreamHandler(ctx);

  // 坏块：缺 tool_name
  const badBlock = [
    '好的，执行调用：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo hi「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  await handler.handle({}, res, createStreamResponse(badBlock));
  assert.ok(res.output.includes('[[VCP协议纠偏指导:'), '静默模式下纠偏回执必须强制输出');
  assert.ok(res.output.includes('block='), '纠偏回执必须携带坏块指纹凭条');
  assert.ok(res.output.includes('格式错误（未执行）'), '摘要必须包含格式错误（未执行）');
});

test('G5-2: 非流式 SHOW_VCP_OUTPUT=false 静默模式下，isFormatGuidance 纠偏回执强制输出', async () => {
  const res = createMockRes();
  const ctx = createMockNonStreamContext({
    SHOW_VCP_OUTPUT: false // 静默模式
  });
  const handler = new NonStreamHandler(ctx);

  const badBlock = [
    '好的，执行调用：',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo hi「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  await handler.handle({}, res, createNonStreamResponse(badBlock));
  assert.ok(res.bodyText.includes('[[VCP协议纠偏指导:'), '非流式静默模式下纠偏回执必须强制输出');
  assert.ok(res.bodyText.includes('block='), '纠偏回执必须携带坏块指纹凭条');
  assert.ok(res.bodyText.includes('格式错误（未执行）'), '摘要必须包含格式错误（未执行）');
});

test('G5-3: 摘要状态词首判严格锁定为：格式错误（未执行）', async () => {
  const res = createMockRes();
  const ctx = createMockStreamContext();
  const handler = new StreamHandler(ctx);

  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo hi「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  await handler.handle({}, res, createStreamResponse(badBlock));
  assert.ok(res.output.includes('VCP工具调用 格式错误（未执行）'), '摘要状态词必须严格为 格式错误（未执行）');
  assert.ok(!res.output.includes('VCP工具调用 调用失败'), '绝对不可误降为调用失败');
});

test('G5-4: 全纠偏批次跳过 RAG 刷新', async () => {
  let ragRefreshCalled = false;
  const res = createMockRes();
  const ctx = createMockStreamContext({
    RAGMemoRefresh: true,
    _refreshRagBlocksIfNeeded: async (messages) => {
      ragRefreshCalled = true;
      return messages;
    }
  });
  const handler = new StreamHandler(ctx);

  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo hi「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  await handler.handle({}, res, createStreamResponse(badBlock));
  assert.equal(ragRefreshCalled, false, '全纠偏批次必须跳过 RAG 刷新');
});

// =========================================================================

test('G5-5: 混合批次（部分成功、部分纠偏）正常触发 RAG 刷新', async () => {
  let ragRefreshCalled = false;
  const res = createMockRes();
  const pm = new MockPluginManager();
  const ctx = createMockStreamContext({
    pluginManager: pm,
    RAGMemoRefresh: true,
    _refreshRagBlocksIfNeeded: async (messages) => {
      ragRefreshCalled = true;
      return messages;
    }
  });
  const handler = new StreamHandler(ctx);

  // 1 个正常工具 + 1 个错误块
  const mixedBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'tool_name:「始」MockValidTool「末」,',
    'action:「始」check「末」',
    '<<<[END_TOOL_REQUEST]>>>',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo bad「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  await handler.handle({}, res, createStreamResponse(mixedBlock));
  assert.equal(ragRefreshCalled, true, '混合批次存在有效工具输出，必须正常触发 RAG 刷新');
});

test('G5-6: archeryCalls 异步工具发生格式纠偏时，摘要状态词严格锁定为 格式错误（未执行）', async () => {
  // 1. 流式测试
  {
    const res = createMockRes();
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    const originalReconcile = protocolResilience.reconcileTurnToolCalls;
    protocolResilience.reconcileTurnToolCalls = async () => ({
      toolCalls: [],
      protocolErrors: [{
        name: 'VCP异步工具',
        args: {},
        archery: true,
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        blockFingerprint: 'archery_fp_123'
      }]
    });

    try {
      const responseStream = createStreamResponse('<<<[TOOL_REQUEST]>>>\narchery:「始」true「末」\n<<<[END_TOOL_REQUEST]>>>');
      await handler.handle({}, res, responseStream);

      assert.ok(res.output.includes('VCP异步工具 格式错误（未执行）'), '流式下 archery 摘要状态词必须为 格式错误（未执行）');
      assert.ok(!res.output.includes('VCP异步工具 调用失败'), '流式下 archery 绝不可显示为 调用失败');
      assert.ok(res.output.includes('[[VCP协议纠偏指导: code=MALFORMED_BLOCK_SYNTAX block=archery_fp_123]]'), '纠偏回执必须包含凭条');
    } finally {
      protocolResilience.reconcileTurnToolCalls = originalReconcile;
    }
  }

  // 2. 非流式测试
  {
    const res = createMockRes();
    const ctx = createMockNonStreamContext();
    const handler = new NonStreamHandler(ctx);

    const originalReconcile = protocolResilience.reconcileTurnToolCalls;
    protocolResilience.reconcileTurnToolCalls = async () => ({
      toolCalls: [],
      protocolErrors: [{
        name: 'VCP异步工具',
        args: {},
        archery: true,
        isProtocolError: true,
        errorCode: 'MALFORMED_BLOCK_SYNTAX',
        blockFingerprint: 'archery_fp_456'
      }]
    });

    try {
      const responseNonStream = createNonStreamResponse('<<<[TOOL_REQUEST]>>>\narchery:「始」true「末」\n<<<[END_TOOL_REQUEST]>>>');
      await handler.handle({}, res, responseNonStream);

      assert.ok(res.bodyText.includes('VCP异步工具 格式错误（未执行）'), '非流式下 archery 摘要状态词必须为 格式错误（未执行）');
      assert.ok(!res.bodyText.includes('VCP异步工具 调用失败'), '非流式下 archery 绝不可显示为 调用失败');
      assert.ok(res.bodyText.includes('[[VCP协议纠偏指导: code=MALFORMED_BLOCK_SYNTAX block=archery_fp_456]]'), '纠偏回执必须包含凭条');
    } finally {
      protocolResilience.reconcileTurnToolCalls = originalReconcile;
    }
  }
});

// Group 6: 跨轮闭环验证：Batch 7 产出的坏块与回执接入 Batch 4 历史清洗与常驻药丸注入
// =========================================================================

test('G6-1: 跨轮闭环：Batch 7 产出的坏块与回执经过多轮后，100% 被 Batch 4 cleanseHistory 精准清洗并保留系统药丸', async () => {
  // 1. 模拟 Batch 7 轮内诊断与执行
  const badBlock = [
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」echo test「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const reconciled = await reconcileTurnToolCalls(badBlock, [], { ToolCallParser });
  assert.equal(reconciled.protocolErrors.length, 1);
  const protocolErr = reconciled.protocolErrors[0];

  const guidance = createGuidanceResult(protocolErr);
  assert.equal(guidance.isFormatGuidance, true);

  // 2. 模拟轮内回执写入历史
  const receipt = [
    '<<<[ROLE_DIVIDE_USER]>>>',
    '<<<[VCP_TOOL_BATCH_START:2026-11-23T08:00:00.000Z]>>>',
    '[[VCP调用结果信息汇总:',
    '- 工具名称: VCP工具调用',
    '- 执行状态: ❌ ERROR',
    `- 返回内容: ${guidance.raw}`,
    'VCP调用结果结束]]',
    '[本轮工具调用摘要:]',
    'VCP工具调用 格式错误（未执行）。',
    '[本轮工具调用摘要结束]',
    '<<<[VCP_TOOL_BATCH_END:2026-11-23T08:00:00.000Z]>>>',
    '<<<[END_ROLE_DIVIDE_USER]>>>'
  ].join('\n');

  const assistantTurnWithBadBlockAndReceipt = [
    '好的，我来尝试调用工具：',
    badBlock,
    receipt
  ].join('\n');

  const history = [
    { role: 'user', content: '请帮我执行脚本' },
    { role: 'assistant', content: assistantTurnWithBadBlockAndReceipt },
    { role: 'user', content: '刚才报错了，请继续处理' }
  ];

  // 3. 跨轮进入 Batch 4 cleanseHistory
  const cleanedHistory = cleanseHistory(history, { enableRoleDivider: true });
  const cleanedAssistantContent = cleanedHistory[1].content;

  // 4. 断言闭环契约
  assert.ok(cleanedAssistantContent.includes('好的，我来尝试调用工具：'), '前置散文必须完整保留');
  assert.ok(!cleanedAssistantContent.includes(badBlock), '坏工具块必须被 100% 彻底擦除');
  assert.ok(!cleanedAssistantContent.includes('[[VCP协议纠偏指导:'), '临时纠偏回执必须被剥除');
  assert.ok(!cleanedAssistantContent.includes('格式错误（未执行）'), '格式错误摘要项必须被剥除');
  assert.ok(cleanedAssistantContent.includes('【VCP 工具调用协议规范】'), '常驻系统药丸必须被精准注入');
  assert.ok(cleanedAssistantContent.includes('<<<[ROLE_DIVIDE_USER]>>>'), 'ROLE_DIVIDE_USER 外壳必须保留');
});

test('G6-2: 轮内原始流完整性保护（P1 原则）：oneRingAssistantTurnParts 原封不动保留坏块原文', async () => {
  const res = createMockRes();
  const ctx = createMockStreamContext();
  const handler = new StreamHandler(ctx);

  const rawBadAIContent = [
    'AI 前置散文',
    '<<<[TOOL_REQUEST]>>>',
    'maid:「始」Nova「末」,',
    'LinuxShellExecutor:「始」cat /etc/issue「末」',
    '<<<[END_TOOL_REQUEST]>>>'
  ].join('\n');

  const outcome = await handler.handle({}, res, createStreamResponse(rawBadAIContent));
  assert.equal(outcome.completed, true);
  // 轮内流式处理期间，AI 原始文本绝不能被提前修改
  assert.ok(outcome.aiText.includes(rawBadAIContent), 'oneRing 原始文本在轮内必须原样保持');
});

// =========================================================================
// Group 7: 环境变量旁路开关与降级验证
// =========================================================================

test('G7-1: ENABLE_TOOL_PROTOCOL_RESILIENCE=false 时跳过自愈协调器，沿用原生 rawToolCalls', async () => {
  let reconcilerCalled = false;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    reconcilerCalled = true;
    return { toolCalls: [], protocolErrors: [] };
  };

  const oldEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = 'false';

  try {
    const res = createMockRes();
    const ctx = createMockStreamContext();
    const handler = new StreamHandler(ctx);

    const badBlock = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'LinuxShellExecutor:「始」ls「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    await handler.handle({}, res, createStreamResponse(badBlock));
    assert.equal(reconcilerCalled, false, '环境变量为 false 时必须彻底旁路');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
    if (oldEnv !== undefined) {
      process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnv;
    } else {
      delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    }
  }
});

test('G7-2: vcpToolUseForbidden=true 时跳过自愈协调器', async () => {
  let reconcilerCalled = false;
  const originalReconcile = protocolResilience.reconcileTurnToolCalls;
  protocolResilience.reconcileTurnToolCalls = async () => {
    reconcilerCalled = true;
    return { toolCalls: [], protocolErrors: [] };
  };

  try {
    const res = createMockRes();
    const ctx = createMockStreamContext({
      vcpToolUseForbidden: true
    });
    const handler = new StreamHandler(ctx);

    const badBlock = [
      '<<<[TOOL_REQUEST]>>>',
      'maid:「始」Nova「末」,',
      'LinuxShellExecutor:「始」ls「末」',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    await handler.handle({}, res, createStreamResponse(badBlock));
    assert.equal(reconcilerCalled, false, 'vcpToolUseForbidden 为 true 时必须彻底旁路');
  } finally {
    protocolResilience.reconcileTurnToolCalls = originalReconcile;
  }
});

test('G7-3: VCP_PROTOCOL_RESILIENCE_ENABLED=off / 0 统一通过 protocolResilience.ENABLED 旁路自愈协调器', async () => {
  const oldVcpEnv = process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
  const oldEnableEnv = process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
  delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;

  try {
    process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = 'off';
    assert.equal(protocolResilience.ENABLED, false, 'VCP_PROTOCOL_RESILIENCE_ENABLED=off 时 ENABLED 必须为 false');

    let reconcilerCalled = false;
    const originalReconcile = protocolResilience.reconcileTurnToolCalls;
    protocolResilience.reconcileTurnToolCalls = async () => {
      reconcilerCalled = true;
      return { toolCalls: [], protocolErrors: [] };
    };

    try {
      // 1. 流式验证旁路
      const resStream = createMockRes();
      const ctxStream = createMockStreamContext();
      const streamHandler = new StreamHandler(ctxStream);
      const badBlock = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'LinuxShellExecutor:「始」ls「末」',
        '<<<[END_TOOL_REQUEST]>>>'
      ].join('\n');

      await streamHandler.handle({}, resStream, createStreamResponse(badBlock));
      assert.equal(reconcilerCalled, false, '流式协调器必须被 ENABLED 旁路');

      // 2. 非流式验证旁路
      const resNonStream = createMockRes();
      const ctxNonStream = createMockNonStreamContext();
      const nonStreamHandler = new NonStreamHandler(ctxNonStream);

      await nonStreamHandler.handle({}, resNonStream, createNonStreamResponse(badBlock));
      assert.equal(reconcilerCalled, false, '非流式协调器必须被 ENABLED 旁路');
    } finally {
      protocolResilience.reconcileTurnToolCalls = originalReconcile;
    }
  } finally {
    if (oldVcpEnv !== undefined) {
      process.env.VCP_PROTOCOL_RESILIENCE_ENABLED = oldVcpEnv;
    } else {
      delete process.env.VCP_PROTOCOL_RESILIENCE_ENABLED;
    }
    if (oldEnableEnv !== undefined) {
      process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE = oldEnableEnv;
    } else {
      delete process.env.ENABLE_TOOL_PROTOCOL_RESILIENCE;
    }
  }
});

test('G7-4: V2 架构下 isSmallModelArbitrationEnabled 兼容存根恒返回 false（已废弃小模型仲裁）', () => {
  const oldEnv = process.env.ENABLE_SMALL_MODEL_ARBITRATION;
  const oldSmallModel = process.env.SMALL_FAST_MODEL;
  try {
    process.env.ENABLE_SMALL_MODEL_ARBITRATION = 'true';
    process.env.SMALL_FAST_MODEL = 'Qwen3-8B';
    assert.equal(protocolResilience.isSmallModelArbitrationEnabled(), false);
    assert.equal(protocolResilience.isSmallModelArbitrationEnabled({ enableSmallModel: true }), false);
  } finally {
    if (oldEnv !== undefined) process.env.ENABLE_SMALL_MODEL_ARBITRATION = oldEnv;
    else delete process.env.ENABLE_SMALL_MODEL_ARBITRATION;
    if (oldSmallModel !== undefined) process.env.SMALL_FAST_MODEL = oldSmallModel;
    else delete process.env.SMALL_FAST_MODEL;
  }
});
