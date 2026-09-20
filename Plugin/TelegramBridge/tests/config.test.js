'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..');
const projectBasePath = path.resolve(pluginRoot, '..', '..');

function loadConfigModule() {
  return require('../src/config');
}

function validEnabledRaw(overrides = {}) {
  return {
    TELEGRAM_MODE: 'enabled',
    TELEGRAM_BOT_TOKEN: 'fixture-bot-token-value',
    TELEGRAM_ALLOWED_USER_IDS: '900719925474099312345',
    TELEGRAM_ALLOWED_CHAT_IDS: '',
    TELEGRAM_GROUPS_ENABLED: 'false',
    TELEGRAM_DEFAULT_AGENT: 'ExampleAgent',
    TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent',
    TELEGRAM_POLL_TIMEOUT_SEC: '30',
    TELEGRAM_UPDATE_LIMIT: '50',
    TELEGRAM_MAX_CONCURRENT_SCOPES: '3',
    TELEGRAM_MAX_QUEUED_TOTAL: '100',
    TELEGRAM_MAX_QUEUED_PER_SCOPE: '20',
    TELEGRAM_MAX_INBOUND_BYTES: '19922944',
    TELEGRAM_MAX_OUTBOUND_BYTES: '47185920',
    TELEGRAM_HISTORY_MAX_MESSAGES: '40',
    TELEGRAM_HISTORY_MAX_BYTES: '262144',
    TELEGRAM_STATE_DIR: '',
    TELEGRAM_VCP_BASE_URL: 'http://127.0.0.1:6005/v1',
    TELEGRAM_VCP_MODEL: 'VCPModelAuto',
    TELEGRAM_VCP_KEY: 'fixture-vcp-key-value',
    TELEGRAM_STREAM_MODE: 'draft',
    TELEGRAM_PROACTIVE_ENABLED: 'false',
    TELEGRAM_LOG_CONTENT: 'false',
    ...overrides,
  };
}

function parse(raw, options = {}) {
  const { parseConfig } = loadConfigModule();
  return parseConfig(raw, {
    projectBasePath,
    production: false,
    ...options,
  });
}

test('outbound DNS defaults to system and accepts only explicit cloudflare selection', () => {
  assert.equal(parse({}).outboundDns, 'system');
  assert.equal(parse(validEnabledRaw({ TELEGRAM_OUTBOUND_DNS: 'cloudflare' })).outboundDns, 'cloudflare');
  assert.equal(parse(validEnabledRaw({ TELEGRAM_OUTBOUND_DNS: 'system' })).outboundDns, 'system');
  for (const value of ['', 'auto', 'https://private.invalid/dns', 'CLOUDFLARE']) {
    assert.throws(() => parse(validEnabledRaw({ TELEGRAM_OUTBOUND_DNS: value })),
      error => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_OUTBOUND_DNS');
  }
});

test('model overrides are explicit, allowlisted per Agent and use bounded generation settings', () => {
  const cfg=parse(validEnabledRaw({TELEGRAM_AGENT_MODELS:'{"ExampleAgent":"gemini-3.7-flash"}',TELEGRAM_VCP_TEMPERATURE:'0.7',TELEGRAM_VCP_MAX_TOKENS:'60000'}));
  assert.deepEqual(cfg.agentModels,{ExampleAgent:'gemini-3.7-flash'});
  assert.equal(cfg.vcpTemperature,0.7);assert.equal(cfg.vcpMaxTokens,60000);
  assert.equal(parse({}).vcpTemperature,null);assert.equal(parse({}).vcpMaxTokens,null);
  for(const raw of [
    {TELEGRAM_AGENT_MODELS:'{"Other":"gemini-3.7-flash"}'},
    {TELEGRAM_AGENT_MODELS:'{"ExampleAgent":"https://secret.invalid"}'},
    {TELEGRAM_AGENT_MODELS:'[]'}, {TELEGRAM_AGENT_MODELS:'{"__proto__":"x"}'},
    {TELEGRAM_VCP_TEMPERATURE:'3'}, {TELEGRAM_VCP_TEMPERATURE:'NaN'},
    {TELEGRAM_VCP_MAX_TOKENS:'0'}, {TELEGRAM_VCP_MAX_TOKENS:'60000.1'},
  ]) assert.throws(()=>parse(validEnabledRaw(raw)),e=>e.code==='CONFIG_INVALID');
});

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertSanitizedConfigError(error, fixtures = []) {
  const { ConfigError } = loadConfigModule();
  assert.equal(error instanceof ConfigError, true);
  assert.equal(typeof error.code, 'string');
  assert.equal(typeof error.field, 'string');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'field']);

  const serialized = [
    error.message,
    error.stack,
    JSON.stringify(error),
    JSON.stringify(Object.assign({}, error)),
  ].join('\n');

  for (const fixture of fixtures.filter((value) => (
    typeof value === 'string' && value.length >= 8
  ))) {
    assert.equal(serialized.includes(fixture), false);
  }
}

test('defaults return a deeply frozen disabled configuration without secrets', () => {
  const config = parse({});

  assert.equal(config.mode, 'disabled');
  assert.equal(config.botToken, '');
  assert.equal(config.vcpKey, '');
  assert.equal(config.vcpModel, 'VCPModelAuto');
  assert.deepEqual(config.allowedUserIds, []);
  assert.deepEqual(config.allowedChatIds, []);
  assert.equal(config.defaultAgent, 'ExampleAgent');
  assert.deepEqual(config.allowedAgents, ['ExampleAgent']);
  assert.equal(config.maxQueuedTotal, 100);
  assert.equal(config.maxQueuedPerScope, 20);
  assert.equal(
    config.stateDir,
    path.join(projectBasePath, 'Plugin', 'TelegramBridge', 'state'),
  );
  assertDeepFrozen(config);
});

test('disabled mode accepts missing credentials and validates supplied common values', () => {
  const config = parse({
    TELEGRAM_MODE: 'disabled',
    TELEGRAM_UPDATE_LIMIT: '100',
    TELEGRAM_STREAM_MODE: 'edit',
  });

  assert.equal(config.updateLimit, 100);
  assert.equal(config.streamMode, 'edit');
  assert.throws(
    () => parse({ TELEGRAM_MODE: 'disabled', TELEGRAM_UPDATE_LIMIT: '987654321' }),
    (error) => {
      assertSanitizedConfigError(error, ['987654321']);
      return true;
    },
  );
});

for (const mode of ['probe', 'enabled']) {
  for (const [field, value] of [
    ['TELEGRAM_BOT_TOKEN', ''],
    ['TELEGRAM_ALLOWED_USER_IDS', ''],
    ['TELEGRAM_VCP_KEY', ''],
  ]) {
    test(`${mode} requires ${field}`, () => {
      const raw = validEnabledRaw({ TELEGRAM_MODE: mode, [field]: value });
      assert.throws(
        () => parse(raw),
        (error) => {
          assert.equal(error.code, 'CONFIG_REQUIRED');
          assert.equal(error.field, field);
          assertSanitizedConfigError(error, Object.values(raw));
          return true;
        },
      );
    });
  }
}

test('configuration errors never serialize rejected values or secret fixtures', () => {
  const fixtures = [
    'fixture-bot-token-value',
    'fixture-vcp-key-value',
    '900719925474099312345',
    'https://example.invalid/v1?token=fixture-url-secret',
    'C:\\private\\fixture-path',
  ];
  const raw = validEnabledRaw({
    TELEGRAM_UPDATE_LIMIT: '30junk',
    TELEGRAM_VCP_BASE_URL: fixtures[3],
    TELEGRAM_STATE_DIR: fixtures[4],
  });

  assert.throws(
    () => parse(raw),
    (error) => {
      assertSanitizedConfigError(error, [...fixtures, ...Object.values(raw)]);
      return true;
    },
  );
});

test('modes are exact lowercase values', () => {
  for (const invalid of ['Disabled', 'PROBE', ' enabled', 'enabled ', '', 'other']) {
    assert.throws(
      () => parse({ TELEGRAM_MODE: invalid }),
      (error) => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_MODE',
    );
  }

  assert.equal(parse({ TELEGRAM_MODE: 'disabled' }).mode, 'disabled');
  assert.equal(parse(validEnabledRaw({ TELEGRAM_MODE: 'probe' })).mode, 'probe');
  assert.equal(parse(validEnabledRaw()).mode, 'enabled');
});

test('booleans accept only exact true and false strings', () => {
  for (const field of [
    'TELEGRAM_GROUPS_ENABLED',
    'TELEGRAM_PROACTIVE_ENABLED',
    'TELEGRAM_LOG_CONTENT',
  ]) {
    const supportingConfig = field === 'TELEGRAM_GROUPS_ENABLED'
      ? {
          TELEGRAM_ALLOWED_USER_IDS: '1',
          TELEGRAM_ALLOWED_CHAT_IDS: '-1001',
        }
      : {};
    assert.equal(parse({ ...supportingConfig, [field]: 'true' })[
      field === 'TELEGRAM_GROUPS_ENABLED'
        ? 'groupsEnabled'
        : field === 'TELEGRAM_PROACTIVE_ENABLED'
          ? 'proactiveEnabled'
          : 'logContent'
    ], true);
    assert.equal(parse({ ...supportingConfig, [field]: 'false' })[
      field === 'TELEGRAM_GROUPS_ENABLED'
        ? 'groupsEnabled'
        : field === 'TELEGRAM_PROACTIVE_ENABLED'
          ? 'proactiveEnabled'
          : 'logContent'
    ], false);

    for (const invalid of ['1', 'yes', '', 'TRUE', 'False']) {
      assert.throws(
        () => parse({ [field]: invalid }),
        (error) => error.code === 'CONFIG_INVALID' && error.field === field,
      );
    }
  }
});

test('integers are digit-only positive safe integers within field ranges', () => {
  const ranges = {
    TELEGRAM_POLL_TIMEOUT_SEC: [1, 50],
    TELEGRAM_UPDATE_LIMIT: [1, 100],
    TELEGRAM_MAX_CONCURRENT_SCOPES: [1, 32],
    TELEGRAM_MAX_QUEUED_TOTAL: [1, 10000],
    TELEGRAM_MAX_QUEUED_PER_SCOPE: [1, 1000],
    TELEGRAM_MAX_INBOUND_BYTES: [1, 19922944],
    TELEGRAM_MAX_OUTBOUND_BYTES: [1, 47185920],
    TELEGRAM_HISTORY_MAX_MESSAGES: [1, 200],
    TELEGRAM_HISTORY_MAX_BYTES: [1, 1048576],
  };

  for (const [field, [min, max]] of Object.entries(ranges)) {
    const supporting = field === 'TELEGRAM_MAX_QUEUED_TOTAL'
      ? { TELEGRAM_MAX_QUEUED_PER_SCOPE: '1' }
      : field === 'TELEGRAM_MAX_QUEUED_PER_SCOPE'
        ? { TELEGRAM_MAX_QUEUED_TOTAL: String(max) }
        : {};
    assert.doesNotThrow(() => parse({ ...supporting, [field]: String(min) }));
    assert.doesNotThrow(() => parse({ ...supporting, [field]: String(max) }));
    for (const invalid of [
      '0',
      String(max + 1),
      '-1',
      '+1',
      '1.5',
      '1e2',
      'Infinity',
      'NaN',
      '30junk',
      '',
      '9007199254740992',
    ]) {
      assert.throws(
        () => parse({ ...supporting, [field]: invalid }),
        (error) => error.code === 'CONFIG_INVALID' && error.field === field,
      );
    }
  }
});

test('per-scope queue limit cannot exceed the total queue limit', () => {
  assert.throws(
    () => parse({
      TELEGRAM_MAX_QUEUED_TOTAL: '19',
      TELEGRAM_MAX_QUEUED_PER_SCOPE: '20',
    }),
    (error) => error.code === 'CONFIG_INVALID'
      && error.field === 'TELEGRAM_MAX_QUEUED_PER_SCOPE',
  );
  assert.equal(parse({
    TELEGRAM_MAX_QUEUED_TOTAL: '20',
    TELEGRAM_MAX_QUEUED_PER_SCOPE: '20',
  }).maxQueuedPerScope, 20);
});

test('large Telegram IDs remain canonical decimal strings', () => {
  const config = parse({
    TELEGRAM_ALLOWED_USER_IDS: '900719925474099312345,42',
    TELEGRAM_ALLOWED_CHAT_IDS: '-1001234567890123456,900719925474099312346',
  });

  assert.deepEqual(config.allowedUserIds, ['900719925474099312345', '42']);
  assert.deepEqual(config.allowedChatIds, [
    '-1001234567890123456',
    '900719925474099312346',
  ]);

  for (const [field, invalid] of [
    ['TELEGRAM_ALLOWED_USER_IDS', '0'],
    ['TELEGRAM_ALLOWED_USER_IDS', '-1'],
    ['TELEGRAM_ALLOWED_USER_IDS', '01'],
    ['TELEGRAM_ALLOWED_USER_IDS', '1,,2'],
    ['TELEGRAM_ALLOWED_USER_IDS', '1, 2'],
    ['TELEGRAM_ALLOWED_CHAT_IDS', '-0'],
    ['TELEGRAM_ALLOWED_CHAT_IDS', '+1'],
    ['TELEGRAM_ALLOWED_CHAT_IDS', '1.0'],
  ]) {
    assert.throws(
      () => parse({ [field]: invalid }),
      (error) => error.code === 'CONFIG_INVALID' && error.field === field,
    );
  }
});

test('groups require both user and chat allowlists', () => {
  for (const override of [
    { TELEGRAM_ALLOWED_USER_IDS: '', TELEGRAM_ALLOWED_CHAT_IDS: '-1001' },
    { TELEGRAM_ALLOWED_USER_IDS: '1', TELEGRAM_ALLOWED_CHAT_IDS: '' },
  ]) {
    assert.throws(
      () => parse({ TELEGRAM_GROUPS_ENABLED: 'true', ...override }),
      (error) => error.code === 'CONFIG_REQUIRED',
    );
  }

  const config = parse({
    TELEGRAM_GROUPS_ENABLED: 'true',
    TELEGRAM_ALLOWED_USER_IDS: '1',
    TELEGRAM_ALLOWED_CHAT_IDS: '-1001',
  });
  assert.equal(config.groupsEnabled, true);
});

test('Agent list is nonempty and contains the default Agent exactly', () => {
  assert.throws(
    () => parse({ TELEGRAM_ALLOWED_AGENTS: '' }),
    (error) => error.code === 'CONFIG_REQUIRED' && error.field === 'TELEGRAM_ALLOWED_AGENTS',
  );
  assert.throws(
    () => parse({ TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent,Yuzu', TELEGRAM_DEFAULT_AGENT: 'example-agent' }),
    (error) => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_DEFAULT_AGENT',
  );
  assert.deepEqual(
    parse({ TELEGRAM_ALLOWED_AGENTS: 'ExampleAgent,Yuzu', TELEGRAM_DEFAULT_AGENT: 'Yuzu' }).allowedAgents,
    ['ExampleAgent', 'Yuzu'],
  );
});

test('VCP base URL accepts literal loopback HTTP and canonicalizes /v1', () => {
  assert.equal(
    parse({ TELEGRAM_VCP_BASE_URL: 'http://127.0.0.1:6005/v1/' }).vcpBaseUrl,
    'http://127.0.0.1:6005/v1',
  );
  assert.equal(
    parse({ TELEGRAM_VCP_BASE_URL: 'http://[::1]:6005/v1' }).vcpBaseUrl,
    'http://[::1]:6005/v1',
  );

  for (const invalid of [
    'https://127.0.0.1:6005/v1',
    'http://localhost:6005/v1',
    'http://127.0.0.2:6005/v1',
    'http://user:pass@127.0.0.1:6005/v1',
    'http://127.0.0.1:6005/v1?key=x',
    'http://127.0.0.1:6005/v1#fragment',
    'http://127.0.0.1:6005/',
    'ws://127.0.0.1:6005/v1',
  ]) {
    assert.throws(
      () => parse({ TELEGRAM_VCP_BASE_URL: invalid }),
      (error) => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_VCP_BASE_URL',
    );
  }
});

test('VCP model is a trusted strict identifier with a stable default', () => {
  assert.equal(parse({}).vcpModel, 'VCPModelAuto');
  assert.equal(
    parse({ TELEGRAM_VCP_MODEL: 'VCPModelAuto-v2.preview' }).vcpModel,
    'VCPModelAuto-v2.preview',
  );

  for (const invalid of [
    '',
    ' VCPModelAuto',
    'VCPModelAuto ',
    'model/../../other',
    '{{agent:ExampleAgent}}',
    'a'.repeat(129),
  ]) {
    assert.throws(
      () => parse({ TELEGRAM_VCP_MODEL: invalid }),
      (error) => error.code === (invalid === '' ? 'CONFIG_REQUIRED' : 'CONFIG_INVALID')
        && error.field === 'TELEGRAM_VCP_MODEL',
    );
  }
});

test('state directory stays inside the TelegramBridge plugin root and creates nothing', () => {
  const inside = path.join(pluginRoot, 'state', 'custom');
  assert.equal(parse({ TELEGRAM_STATE_DIR: inside }).stateDir, inside);
  assert.equal(
    parse({ TELEGRAM_STATE_DIR: 'state/custom' }).stateDir,
    inside,
  );
  assert.throws(
    () => parse({ TELEGRAM_STATE_DIR: path.resolve(pluginRoot, '..', 'outside') }),
    (error) => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_STATE_DIR',
  );
});

test('production forbids content logging and stream mode is exact', () => {
  assert.throws(
    () => parse({ TELEGRAM_LOG_CONTENT: 'true' }, { production: true }),
    (error) => error.code === 'CONFIG_FORBIDDEN' && error.field === 'TELEGRAM_LOG_CONTENT',
  );
  assert.equal(parse({ TELEGRAM_STREAM_MODE: 'draft' }).streamMode, 'draft');
  assert.equal(parse({ TELEGRAM_STREAM_MODE: 'edit' }).streamMode, 'edit');
  assert.throws(
    () => parse({ TELEGRAM_STREAM_MODE: 'Draft' }),
    (error) => error.code === 'CONFIG_INVALID' && error.field === 'TELEGRAM_STREAM_MODE',
  );
});

test('unknown TELEGRAM keys are rejected while host injections are ignored', () => {
  const unknownKey = 'TELEGRAM_SECRET_FIXTURE_998877';
  assert.throws(
    () => parse({ [unknownKey]: 'fixture-unknown-value' }),
    (error) => {
      assert.equal(error.code, 'CONFIG_UNKNOWN_KEY');
      assert.equal(error.field, 'TELEGRAM_UNKNOWN');
      assertSanitizedConfigError(error, ['fixture-unknown-value', unknownKey]);
      return true;
    },
  );
  assert.doesNotThrow(() => parse({ PORT: 6005, Key: 'must-not-be-used', PROJECT_BASE_PATH: projectBasePath }));
  assert.equal(
    parse({ Key: 'must-not-be-used' }).vcpKey,
    '',
  );
});
