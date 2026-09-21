'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  VcpConversationError,
  createSseParser,
} = require('../src/vcpConversationClient');

function assertVcpError(error, code) {
  assert.equal(error instanceof VcpConversationError, true);
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
}

test('SSE parser preserves split UTF-8 and JSON across CR, LF and CRLF boundaries', () => {
  const parser = createSseParser({ maxEventBytes: 1024 });
  const bytes = new TextEncoder().encode(
    ': keepalive\r\n'
    + 'data: {"text":"你"\r\n'
    + 'data: ,"ok":true}\r\n\r\n'
    + 'data: second\r\r'
    + 'data: third\n\n',
  );
  const splitInsideCjk = bytes.indexOf(0xe4) + 1;

  assert.deepEqual(parser.push(bytes.subarray(0, splitInsideCjk)), []);
  assert.deepEqual(parser.push(bytes.subarray(splitInsideCjk, splitInsideCjk + 2)), []);
  assert.deepEqual(parser.push(bytes.subarray(splitInsideCjk + 2)), [
    '{"text":"你"\n,"ok":true}',
    'second',
    'third',
  ]);
  assert.deepEqual(parser.finish(), []);
});

test('SSE parser ignores blank/comment-only events and dispatches a final data event at EOF', () => {
  const parser = createSseParser({ maxEventBytes: 64 });
  assert.deepEqual(parser.push(Buffer.from('\n: one\n\nretry: 1\n\ndata:\n\n')), ['']);
  assert.deepEqual(parser.push(Buffer.from('data: tail')), []);
  assert.deepEqual(parser.finish(), ['tail']);
  assert.throws(() => parser.finish(), (error) => assertVcpError(error, 'VCP_SSE_CLOSED'));
});

test('SSE parser fails closed on malformed UTF-8 and oversized event data', () => {
  const malformed = createSseParser({ maxEventBytes: 64 });
  assert.throws(
    () => malformed.push(Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff])),
    (error) => assertVcpError(error, 'VCP_SSE_INVALID_UTF8'),
  );

  const oversized = createSseParser({ maxEventBytes: 8 });
  assert.throws(
    () => oversized.push(Buffer.from('data: 123456789\n\n')),
    (error) => assertVcpError(error, 'VCP_SSE_EVENT_TOO_LARGE'),
  );
});

test('SSE parser rejects invalid configuration and input without leaking raw values', () => {
  assert.throws(
    () => createSseParser({ maxEventBytes: 0 }),
    (error) => assertVcpError(error, 'VCP_SSE_CONFIG_INVALID'),
  );
  const parser = createSseParser({ maxEventBytes: 64 });
  assert.throws(
    () => parser.push('data: fixture-secret'),
    (error) => assertVcpError(error, 'VCP_SSE_INPUT_INVALID'),
  );
});
