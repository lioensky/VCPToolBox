'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const ToolCallParser = require('../modules/vcpLoop/toolCallParser');
const toolMarkerFuzzyMatcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');
const { projectToolBatchForUpstream } = require('../modules/toolResultBatch');
const StreamHandler = require('../modules/handlers/streamHandler');

function makeToolReq(toolName, extraFields = '') {
  return [
    '<<<[TOOL_REQUEST]>>>',
    `tool_name:「始」${toolName}「末」${extraFields ? ',' : ''}`,
    extraFields,
    '<<<[END_TOOL_REQUEST]>>>'
  ].filter(Boolean).join('\n');
}

test('ToolCallParser: truncates hallucinated user + VCP_TOOL_PAYLOAD and ignores subsequent fake tool calls', () => {
  const raw = [
    makeToolReq('MacCodexBridge', 'command:「始」ListCodexThreads「末」'),
    makeToolReq('MacCodexBridge', 'command:「始」ListSessions「末」'),
    'user',
    '<!-- VCP_TOOL_PAYLOAD -->',
    'Results:',
    '[1] MacCodexBridge',
    'fake thread list',
    '<!-- VCP_TOOL_PAYLOAD_END -->',
    makeToolReq('MacCodexBridge', 'command:「始」WaitTask「末」,\njobId:「始」fake-job-id「末」')
  ].join('\n');

  const cut = ToolCallParser.findHallucinatedToolPayloadCut(raw);
  assert.ok(cut, 'should detect hallucinated payload sentinel');
  const cleaned = ToolCallParser.truncateHallucinatedToolPayload(raw);
  assert.equal(cleaned.includes('fake-job-id'), false);
  assert.equal(cleaned.includes('VCP_TOOL_PAYLOAD'), false);
  assert.equal(/\nuser\b/.test(cleaned), false);

  const calls = ToolCallParser.parse(raw);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.command, 'ListCodexThreads');
  assert.equal(calls[1].args.command, 'ListSessions');
});

test('ToolCallParser: never false-positives on self-referential code diffs, fenced code blocks, plain text, or think blocks', () => {
  // 1. Editing toolResultBatch.js inside a tool argument (closed and unclosed)
  const diffArg = [
    'command:「始」ApplyDiff「末」,',
    'target:「始」const header = \'<!-- VCP_TOOL_PAYLOAD -->\\nResults:\';「末」'
  ].join('\n');
  const closedSelfEdit = makeToolReq('ServerFileOperator', diffArg);
  assert.equal(ToolCallParser.findHallucinatedToolPayloadCut(closedSelfEdit), null);
  assert.equal(ToolCallParser.parse(closedSelfEdit).length, 1);

  const streamingUnclosedSecondTool = [
    makeToolReq('ServerFileOperator', 'command:「始」ReadFile「末」'),
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」ServerFileOperator「末」,',
    'content:「始」',
    'user',
    '<!-- VCP_TOOL_PAYLOAD -->',
    'Results:'
  ].join('\n');
  assert.equal(ToolCallParser.findHallucinatedToolPayloadCut(streamingUnclosedSecondTool), null);

  // 2. Quoted inside fenced code block after a tool block
  const fencedAfterTool = [
    makeToolReq('ServerFileOperator', 'command:「始」ReadFile「末」'),
    '说明如下：',
    '```text',
    'user',
    '<!-- VCP_TOOL_PAYLOAD -->',
    'Results:',
    '```'
  ].join('\n');
  assert.equal(ToolCallParser.findHallucinatedToolPayloadCut(fencedAfterTool), null);

  // 3. Plain reply with no tool call at all
  const plainReply = '讨论协议格式：\nuser\n<!-- VCP_TOOL_PAYLOAD -->\nResults:\nfoo';
  assert.equal(ToolCallParser.findHallucinatedToolPayloadCut(plainReply), null);

  // 4. Inside <think> block
  const insideThink = [
    '<think>',
    makeToolReq('MacCodexBridge', 'command:「始」StartTask「末」'),
    'user',
    '<!-- VCP_TOOL_PAYLOAD -->',
    '</think>',
    makeToolReq('MacCodexBridge', 'command:「始」ListSessions「末」')
  ].join('\n');
  assert.equal(ToolCallParser.findHallucinatedToolPayloadCut(insideThink), null);
  const calls = ToolCallParser.parse(insideThink);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.command, 'ListSessions');
});

test('projectToolBatchForUpstream: strips hallucinated payload from historical assistant turns only', () => {
  const dirtyAssistant = [
    makeToolReq('MacFileOperator', 'command:「始」WriteFile「末」'),
    'user',
    '<!-- VCP_TOOL_PAYLOAD -->',
    'Results:',
    '[1] MacFileOperator',
    'fake write ok',
    '<!-- VCP_TOOL_PAYLOAD_END -->',
    '正常后续总结'
  ].join('\n');

  const safeAssistantCodeBlock = [
    makeToolReq('ServerFileOperator', 'command:「始」ReadFile「末」'),
    '```html',
    '<!-- VCP_TOOL_PAYLOAD -->',
    'Results:',
    '<!-- VCP_TOOL_PAYLOAD_END -->',
    '```'
  ].join('\n');

  const realUserPayload = '<!-- VCP_TOOL_PAYLOAD -->\nResults:\n[1] MacFileOperator\nreal ok\n<!-- VCP_TOOL_PAYLOAD_END -->';

  const body = {
    model: 'gemini-4-neon-PG',
    messages: [
      { role: 'assistant', content: dirtyAssistant },
      { role: 'user', content: realUserPayload },
      { role: 'assistant', content: safeAssistantCodeBlock }
    ]
  };

  const projected = projectToolBatchForUpstream(body);
  // Original input must not be mutated
  assert.equal(body.messages[0].content, dirtyAssistant);
  // Historical dirty assistant has hallucinated payload & bare user line stripped, summary preserved
  assert.equal(projected.messages[0].content.includes('VCP_TOOL_PAYLOAD'), false);
  assert.equal(projected.messages[0].content.includes('fake write ok'), false);
  assert.equal(projected.messages[0].content.includes('正常后续总结'), true);
  // Real user payload stays untouched
  assert.equal(projected.messages[1].content, realUserPayload);
  // Code block inside assistant stays untouched
  assert.equal(projected.messages[2].content, safeAssistantCodeBlock);
});

test('toolMarkerFuzzyMatcher: accepts guillemet variants with 始/末 and rejects delimiter-only «」', () => {
  const prevEnabled = toolMarkerFuzzyMatcher.isEnabled();
  try {
    toolMarkerFuzzyMatcher.configure({ enabled: true, debugMode: false });
    const guillemetBlock = [
      '<<<[TOOL_REQUEST]>>>',
      'tool_name:「始」MacCodexBridge「末」,',
      'command:「始」StartTask「末」,',
      'task:「始」第一段评审意见。\n第二段评审意见。«末»',
      '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const calls1 = ToolCallParser.parse(guillemetBlock);
    assert.equal(calls1.length, 1);
    assert.equal(calls1[0].args.task, '第一段评审意见。\n第二段评审意见。');

    const mixedRightGuillemet = guillemetBlock.replace('«末»', '「末»');
    const calls2 = ToolCallParser.parse(mixedRightGuillemet);
    assert.equal(calls2.length, 1);
    assert.equal(calls2[0].args.task, '第一段评审意见。\n第二段评审意见。');

    // Missing 末 character must NOT be matched as a closing delimiter
    const missingChar = guillemetBlock.replace('«末»', '«」');
    const calls3 = ToolCallParser.parse(missingChar);
    assert.equal(calls3.length, 1);
    assert.equal(calls3[0].args.task, undefined);
  } finally {
    toolMarkerFuzzyMatcher.configure({ enabled: prevEnabled, debugMode: false });
  }
});

test('StreamHandler: intercepts split user + VCP_TOOL_PAYLOAD mid-stream, hides user from client, destroys upstream, and runs only real tool', async () => {
  const chunksOut = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    headersSent: true,
    write(chunk) { chunksOut.push(String(chunk)); },
    end() { this.writableEnded = true; }
  };

  const executedTools = [];
  const sseChunk = (content, finishReason = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: content !== null ? { content } : {}, finish_reason: finishReason }]
    })}\n\n`;

  const turn1Stream = new PassThrough();
  let turn1Destroyed = false;
  const origDestroy = turn1Stream.destroy.bind(turn1Stream);
  turn1Stream.destroy = (...args) => {
    turn1Destroyed = true;
    return origDestroy(...args);
  };

  const turn2Stream = new PassThrough();

  const handler = new StreamHandler({
    apiUrl: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    originalBody: {
      model: 'gemini-4-neon-PG',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      requestId: 'req-halluc-test'
    },
    abortController: new AbortController(),
    maxVCPLoop: 3,
    apiRetries: 1,
    apiRetryDelay: 10,
    DEBUG_MODE: false,
    SHOW_VCP_OUTPUT: false,
    enableRoleDivider: true,
    enableRoleDividerInLoop: true,
    roleDividerIgnoreList: [],
    roleDividerSwitches: {},
    roleDividerScanSwitches: {},
    roleDividerRemoveDisabledTags: true,
    RAGMemoRefresh: false,
    clientIp: '127.0.0.1',
    fetchWithRetry: async () => {
      setImmediate(() => {
        turn2Stream.write(sseChunk('最终真实回答'));
        turn2Stream.write(sseChunk(null, 'stop'));
        turn2Stream.write('data: [DONE]\n\n');
        turn2Stream.end();
      });
      return { ok: true, status: 200, body: turn2Stream };
    },
    vcpToolUseForbidden: false,
    ToolCallParser,
    toolExecutor: {
      expandCalls: async (calls) => calls,
      async execute(call) {
        executedTools.push(call);
        return {
          success: true,
          content: [{ type: 'text', text: 'REAL_TOOL_RESULT_OK' }],
          raw: { status: 'success' }
        };
      },
      async executeAll(calls) {
        return Promise.all(calls.map(call => this.execute(call)));
      }
    },
    vcpInfoHandler: { streamVcpInfo: () => '' },
    isToolResultError: () => false
  });

  // Push turn 1 with real tool call, then split `\nuser\n` and `<!-- VCP_TOOL_PAYLOAD -->` across chunks + fake follow-up tool
  setImmediate(() => {
    turn1Stream.write(sseChunk(makeToolReq('MacCodexBridge', 'command:「始」ListSessions「末」')));
    turn1Stream.write(sseChunk('\nuser\n'));
    turn1Stream.write(sseChunk('<!-- VCP_TOOL_PAYLOAD -->\nResults:\n[1] MacCodexBridge\nFAKE RESULT\n<!-- VCP_TOOL_PAYLOAD_END -->\n'));
    turn1Stream.write(sseChunk(makeToolReq('MacCodexBridge', 'command:「始」WaitTask「末」,\njobId:「始」fake-job「末」')));
    turn1Stream.write(sseChunk(null, 'stop'));
    turn1Stream.end();
  });

  await handler.handle({}, res, { ok: true, status: 200, body: turn1Stream });

  assert.equal(turn1Destroyed, true, 'upstream stream should be destroyed immediately upon sentinel');
  assert.equal(executedTools.length, 1, 'only the real tool call before sentinel should execute');
  assert.equal(executedTools[0].args.command, 'ListSessions');

  const clientCombined = chunksOut.join('');
  assert.equal(clientCombined.includes('FAKE RESULT'), false, 'fake result must not leak to client');
  assert.equal(clientCombined.includes('VCP_TOOL_PAYLOAD'), false, 'sentinel must not leak to client');
  assert.equal(clientCombined.includes('\\nuser\\n'), false, 'bare user holdback must not leak to client');
  assert.equal(clientCombined.includes('最终真实回答'), true, 'real turn 2 answer must be delivered');
});
