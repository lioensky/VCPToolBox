'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');

function makeExecutor() {
  const stub = Object.create(ToolExecutor.prototype);
  stub.webSocketServer = { broadcast: () => {} };
  stub.debugMode = false;
  return stub;
}

test('toolExecutor._createErrorResult: plain string errors retain content and omit contentForAI', () => {
  const executor = makeExecutor();
  const res = executor._createErrorResult('DemoTool', 'Network request timeout');
  assert.equal(res.success, false);
  assert.equal(res.error, 'Network request timeout');
  assert.deepEqual(res.content, [{ type: 'text', text: '[错误] Network request timeout' }]);
  assert.equal(res.contentForAI, undefined);
  assert.equal(res.raw, undefined);
});

test('toolExecutor._createErrorResult: approval rejection retains readable content and omits contentForAI when result is absent', () => {
  const executor = makeExecutor();
  const payload = JSON.stringify({
    plugin_error: 'Execution rejected by admin.',
    user_feedback: 'Unsafe command',
    error_type: 'approval_rejected'
  });
  const res = executor._createErrorResult('DemoTool', '执行错误: ' + payload);
  assert.equal(res.success, false);
  assert.match(res.content[0].text, /Execution rejected by admin/);
  assert.match(res.content[0].text, /用户反馈: Unsafe command/);
  assert.equal(res.contentForAI, undefined);
  assert.equal(res.raw.error_type, 'approval_rejected');
});

test('toolExecutor._createErrorResult: structured error result object is exposed to contentForAI', () => {
  const executor = makeExecutor();
  const businessErrorResult = {
    exitCode: 7,
    stderr: 'command not found',
    retryable: false,
    diagnostics: { host: 'node-1' }
  };
  const payload = JSON.stringify({
    plugin_error: 'Process terminated with non-zero exit code.',
    result: businessErrorResult
  });
  const res = executor._createErrorResult('DemoTool', '执行错误: ' + payload);
  assert.equal(res.success, false);
  assert.match(res.content[0].text, /Process terminated with non-zero exit code/);
  assert.ok(Array.isArray(res.contentForAI));
  assert.equal(res.contentForAI.length, 1);
  assert.equal(res.contentForAI[0].type, 'text');
  const parsedForAI = JSON.parse(res.contentForAI[0].text);
  assert.deepEqual(parsedForAI, businessErrorResult);
  assert.deepEqual(res.raw.result, businessErrorResult);
});

test('toolExecutor._createErrorResult: standard content array in result is passed verbatim to contentForAI', () => {
  const executor = makeExecutor();
  const errorParts = [
    { type: 'text', text: '[header]\n{"tool": "Run", "status": "error", "exitCode": 1}' },
    { type: 'text', text: '[output]\nSyntaxError: Unexpected token' }
  ];
  const payload = JSON.stringify({
    plugin_error: 'Task execution failed.',
    result: { content: errorParts }
  });
  const res = executor._createErrorResult('DemoTool', '执行错误: ' + payload);
  assert.equal(res.success, false);
  assert.deepEqual(res.contentForAI, errorParts);
});

test('toolExecutor._createErrorResult: approval feedback note is preserved when structured result exists', () => {
  const executor = makeExecutor();
  const businessErrorResult = { status: 'failed', code: 'PERMISSION_DENIED' };
  const payload = JSON.stringify({
    plugin_error: 'Operation not permitted.',
    __vcpApprovalFeedback: '请检查只读目录',
    result: businessErrorResult
  });
  const res = executor._createErrorResult('DemoTool', '执行错误: ' + payload);
  assert.equal(res.success, false);
  assert.match(res.content[0].text, /请检查只读目录/);
  assert.ok(res.contentForAI.length >= 2);
  assert.match(res.contentForAI[0].text, /请检查只读目录/);
  assert.deepEqual(JSON.parse(res.contentForAI[1].text), businessErrorResult);
});