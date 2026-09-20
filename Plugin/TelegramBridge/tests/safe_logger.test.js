'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function loadLoggerModule() {
  return require('../src/safeLogger');
}

function serialized(records) {
  return JSON.stringify(records);
}

test('safe logger exports a frozen small metadata allowlist', () => {
  const { SAFE_FIELD_ALLOWLIST } = loadLoggerModule();
  assert.equal(Object.isFrozen(SAFE_FIELD_ALLOWLIST), true);
  assert.ok(SAFE_FIELD_ALLOWLIST.includes('mode'));
  assert.ok(SAFE_FIELD_ALLOWLIST.includes('error_code'));
  assert.ok(SAFE_FIELD_ALLOWLIST.includes('http_status'));
  assert.ok(SAFE_FIELD_ALLOWLIST.includes('retryable'));
  assert.equal(SAFE_FIELD_ALLOWLIST.includes('message'), false);
  assert.equal(SAFE_FIELD_ALLOWLIST.includes('path'), false);
  assert.equal(SAFE_FIELD_ALLOWLIST.includes('id'), false);
});

test('logger emits only allowlisted safe primitive metadata and freezes records', () => {
  const { createSafeLogger } = loadLoggerModule();
  const records = [];
  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    hmacKey: 'fixture-hmac-key',
    knownSecrets: ['fixture-known-secret'],
  });

  const fields = {
    mode: 'enabled',
    status: 'ready',
    agent: 'ExampleAgent',
    count: 2,
    mime: 'image/png',
    size_bytes: 42,
    retryable: false,
    unknown: 'must-be-dropped',
    nested: { status: 'must-be-dropped' },
  };
  logger.info('bridge_ready', fields);
  fields.mode = 'mutated';

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    level: 'info',
    event_code: 'bridge_ready',
    mode: 'enabled',
    status: 'ready',
    agent: 'ExampleAgent',
    count: 2,
    mime: 'image/png',
    size_bytes: 42,
    retryable: false,
  });
  assert.equal(Object.isFrozen(records[0]), true);
});

test('logger drops secret-bearing, token-like, Base64, URL, raw ID and path values', () => {
  const { createSafeLogger } = loadLoggerModule();
  const records = [];
  const fixtures = [
    'fixture-known-secret',
    '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', // secret-scan: allow-fixture
    'authorization-code-fixture-998877',
    'data:text/plain;base64,U0VDUkVUX0ZJWFRVUkU=',
    'QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    '900719925474099312345',
    'C:\\private\\telegram\\state.sqlite3',
    '/opt/vcp/private/config.env',
    'https://example.invalid/path?token=fixture-query-secret',
  ];
  const circular = {};
  circular.self = circular;
  const malicious = { toJSON: () => fixtures[0] };
  const rawError = new Error(fixtures[2]);
  rawError.cause = new Error(fixtures[0]);

  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    hmacKey: 'fixture-hmac-key',
    knownSecrets: [fixtures[0], fixtures[2], 'fixture-query-secret'],
  });

  for (const value of fixtures) {
    logger.warn('unsafe_fixture_seen', {
      agent: value,
      tool: value,
      error_code: value,
      scope_hash: value,
    });
  }
  logger.error('object_fixture_seen', {
    mode: rawError,
    status: circular,
    tool: malicious,
    config: { token: fixtures[0] },
    update: circular,
    attachment: { path: fixtures[6] },
    url: new URL(fixtures[8]),
  });

  const output = serialized(records);
  for (const fixture of fixtures) assert.equal(output.includes(fixture), false);
  assert.equal(output.includes('SECRET_FIXTURE'), false);
  assert.doesNotThrow(() => JSON.stringify(records));
});

test('raw Error is dropped while normalized error primitives are accepted', () => {
  const { createSafeLogger } = loadLoggerModule();
  const records = [];
  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    hmacKey: 'fixture-hmac-key',
  });

  logger.error('request_failed', {
    error: new Error('fixture-error-secret'),
    error_code: 'VCP_TIMEOUT',
    http_status: 504,
    retryable: true,
  });

  assert.deepEqual(records[0], {
    level: 'error',
    event_code: 'request_failed',
    error_code: 'VCP_TIMEOUT',
    http_status: 504,
    retryable: true,
  });
  assert.equal(serialized(records).includes('fixture-error-secret'), false);
});

test('invalid event codes cannot become arbitrary log messages', () => {
  const { createSafeLogger } = loadLoggerModule();
  const records = [];
  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    hmacKey: 'fixture-hmac-key',
  });

  logger.info('raw user message fixture', { status: 'ready' });

  assert.deepEqual(records, [{
    level: 'warn',
    event_code: 'logger_event_rejected',
  }]);
});

test('validly shaped event codes still reject known secrets and raw IDs', () => {
  const { createSafeLogger } = loadLoggerModule();
  const records = [];
  const secret = 'fixture_known_secret';
  const logger = createSafeLogger({
    sink: (record) => records.push(record),
    hmacKey: 'fixture-hmac-key',
    knownSecrets: [secret],
  });

  logger.info(secret, { status: 'ready' });
  logger.info('user_900719925474099312345_seen', { status: 'ready' });

  assert.deepEqual(records, [
    { level: 'warn', event_code: 'logger_event_rejected' },
    { level: 'warn', event_code: 'logger_event_rejected' },
  ]);
  assert.equal(serialized(records).includes(secret), false);
  assert.equal(serialized(records).includes('900719925474099312345'), false);
});

test('hashId returns deterministic separated 16-character lowercase HMAC prefixes', () => {
  const { createSafeLogger } = loadLoggerModule();
  const logger = createSafeLogger({
    sink: () => {},
    hmacKey: 'fixture-hmac-key',
  });

  const first = logger.hashId('user', '900719925474099312345');
  const again = logger.hashId('user', '900719925474099312345');
  const differentId = logger.hashId('user', '900719925474099312346');
  const differentKind = logger.hashId('chat', '900719925474099312345');

  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, again);
  assert.notEqual(first, differentId);
  assert.notEqual(first, differentKind);
});

test('sink and fallback failures are contained with one fixed fallback record', () => {
  const { createSafeLogger } = loadLoggerModule();
  const fallbackRecords = [];
  const logger = createSafeLogger({
    sink: () => {
      throw new Error('fixture-sink-secret');
    },
    fallbackSink: (record) => {
      fallbackRecords.push(record);
      throw new Error('fixture-fallback-secret');
    },
    hmacKey: 'fixture-hmac-key',
  });

  assert.doesNotThrow(() => logger.info('bridge_ready', { status: 'ready' }));
  assert.deepEqual(fallbackRecords, [{
    level: 'error',
    event_code: 'logger_sink_failed',
  }]);
  assert.equal(Object.isFrozen(fallbackRecords[0]), true);
  assert.equal(serialized(fallbackRecords).includes('fixture-sink-secret'), false);
  assert.equal(serialized(fallbackRecords).includes('fixture-fallback-secret'), false);
});

test('async sink and async fallback rejections are contained', async () => {
  const { createSafeLogger } = loadLoggerModule();
  const fallbackRecords = [];
  const logger = createSafeLogger({
    sink: () => Promise.reject(new Error('fixture-async-sink-secret')),
    fallbackSink: (record) => {
      fallbackRecords.push(record);
      return Promise.reject(new Error('fixture-async-fallback-secret'));
    },
    hmacKey: 'fixture-hmac-key',
  });

  assert.doesNotThrow(() => logger.info('bridge_ready', { status: 'ready' }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fallbackRecords, [{
    level: 'error',
    event_code: 'logger_sink_failed',
  }]);
  assert.equal(serialized(fallbackRecords).includes('fixture-async-sink-secret'), false);
  assert.equal(serialized(fallbackRecords).includes('fixture-async-fallback-secret'), false);
});
