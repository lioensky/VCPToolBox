'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  VcpVisibleTextFilterError,
  createVcpVisibleTextFilter,
} = require('../src/vcpVisibleTextFilter');

function assertFilterError(error, code) {
  assert.equal(error instanceof VcpVisibleTextFilterError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

function filterAtEveryBoundary(source) {
  const outputs = [];
  for (let split = 0; split <= source.length; split += 1) {
    const filter = createVcpVisibleTextFilter();
    const visible = filter.push(source.slice(0, split))
      + filter.push(source.slice(split))
      + filter.finish();
    outputs.push(visible);
  }
  return outputs;
}

test('split boundaries never expose tool, role, DailyNote, summary or nested thinking payloads', () => {
  const source = [
    'Hello ',
    '<<<[TOOL_REQUEST]>>>tool_name: secret/path<<<[END_TOOL_REQUEST]>>>',
    'world ',
    '<<<[ROLE_DIVIDE_SYSTEM]>>>system secret<<<[END_ROLE_DIVIDE_SYSTEM]>>>',
    '<<<[ROLE_DIVIDE_USER]>>>user secret<<<[END_ROLE_DIVIDE_USER]>>>',
    '<<<[ROLE_DIVIDE_ASSISTANT]>>>assistant <<<[END_ROLE_DIVIDE_ASSISTANT]>>>',
    '<think>reason <thinking>nested</thinking> tail</think>',
    '<<<DailyNoteStart>>>private diary<<<DailyNoteEnd>>>',
    '[本轮工具调用摘要:] private id/path [本轮工具调用摘要结束]',
    'done',
  ].join('');
  for (const visible of filterAtEveryBoundary(source)) {
    assert.equal(visible, 'Hello world assistant done');
    for (const secret of ['secret/path', 'system secret', 'user secret', 'reason', 'private diary', 'private id/path']) {
      assert.equal(visible.includes(secret), false);
    }
  }
});

test('fuzzy request variants, escape regions, tool results and VCP payload comments remain hidden', () => {
  const filter = createVcpVisibleTextFilter();
  const source = [
    'A',
    '<<<[TOOL_REQUEST_EXP]>>>exp-secret<<<[END_TOOL_REQUEST_EXP]>>>',
    'B',
    '<<<[TOOL_REQUEST_ESCAPE]>>>escape-secret<<<[END_TOOL_REQUEST_ESCAPE]>>>',
    'C',
    '<<<[TOOL_RESULT]>>>result-secret<<<[END_TOOL_RESULT]>>>',
    'D',
    '<!-- VCP_TOOL_PAYLOAD -->payload-secret<!-- END_VCP_TOOL_PAYLOAD -->',
    'E',
  ].join('');
  assert.equal(filter.push(source) + filter.finish(), 'ABCDE');
});

test('ambiguous marker prefixes are buffered only until they become ordinary text', () => {
  const filter = createVcpVisibleTextFilter();
  assert.equal(filter.push('safe <<'), 'safe ');
  assert.ok(filter.snapshot().bufferedBytes <= 8);
  assert.equal(filter.push('not-a-marker'), '<<not-a-marker');
  assert.equal(filter.finish(), '');
});

test('hidden payloads are discarded incrementally instead of buffered in full', () => {
  const filter = createVcpVisibleTextFilter();
  assert.equal(filter.push('before<<<[TOOL_REQUEST]>>>'), 'before');
  for (let index = 0; index < 64; index += 1) {
    assert.equal(filter.push('x'.repeat(16 * 1024)), '');
    assert.ok(filter.snapshot().bufferedBytes < 128);
  }
  assert.equal(filter.push('<<<[END_TOOL_REQUEST]>>>after'), 'after');
  assert.equal(filter.finish(), '');
});

test('reasoning fields are ignored while ordinary content is filtered', () => {
  const filter = createVcpVisibleTextFilter();
  assert.equal(filter.push({ content: 'visible', reasoning: 'reasoning-secret' }), 'visible');
  assert.equal(filter.finish(), '');
});

test('unclosed internal blocks, synthetic errors and tool-loop exhaustion fail closed', () => {
  for (const source of ['<think>secret', '<<<[TOOL_REQUEST]>>>secret', '<<<[ROLE_DIVIDE_USER]>>>secret']) {
    const filter = createVcpVisibleTextFilter();
    filter.push(source);
    assert.throws(() => filter.finish(), (error) => assertFilterError(error, 'VISIBLE_FILTER_INCOMPLETE'));
  }
  const mismatched = createVcpVisibleTextFilter();
  mismatched.push('<think>secret</thinking>must-stay-hidden');
  assert.throws(
    () => mismatched.finish(),
    (error) => assertFilterError(error, 'VISIBLE_FILTER_INCOMPLETE'),
  );
  for (const source of ['[ERROR] upstream', '[UPSTREAM_ERROR] upstream', '[上游响应超时，流已中断]']) {
    const filter = createVcpVisibleTextFilter();
    assert.throws(() => filter.push(source), (error) => assertFilterError(error, 'VISIBLE_FILTER_SYNTHETIC_ERROR'));
  }
  const exhausted = createVcpVisibleTextFilter();
  exhausted.push('partial');
  assert.throws(
    () => exhausted.finish({ toolLoopExhausted: true }),
    (error) => assertFilterError(error, 'VISIBLE_FILTER_TOOL_LOOP_EXHAUSTED'),
  );
});

test('hostile input objects fail with stable errors and no content leakage', () => {
  const filter = createVcpVisibleTextFilter();
  const hostile = {};
  Object.defineProperty(hostile, 'content', {
    enumerable: true,
    get() { throw new Error('filter-secret'); },
  });
  assert.throws(
    () => filter.push(hostile),
    (error) => {
      assertFilterError(error, 'VISIBLE_FILTER_INPUT_INVALID');
      assert.equal(`${error.message}\n${error.stack}`.includes('filter-secret'), false);
      return true;
    },
  );
});
