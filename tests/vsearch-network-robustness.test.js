const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const vsearchScript = path.join(repoRoot, 'Plugin', 'VSearch', 'VSearch.js');
const source = fs.readFileSync(vsearchScript, 'utf8');

test('VSearch derives an internal deadline from plugin communication timeout', () => {
  assert.match(source, /manifestPath/);
  assert.match(source, /loadPluginTimeoutMs/);
  assert.match(source, /createDeadlineContext/);
  assert.match(source, /communication\?\.timeout/);
  assert.match(source, /MIN_SAFE_REPLY_MARGIN_MS/);
  assert.match(source, /MAX_SAFE_REPLY_MARGIN_MS/);
});

test('VSearch makes Grounding requests abortable and returns partial results at deadline', () => {
  assert.match(source, /const callGroundingMode = async \(topic, keyword, showURL = false, deadline, signal\)/);
  assert.match(source, /timeout: Math\.min\(180000, remaining\)/);
  assert.match(source, /signal/);
  assert.match(source, /withDeadline/);
  assert.match(source, /controllers\.forEach\(controller => controller\.abort\(\)\)/);
  assert.match(source, /已到达插件安全截止时间，未完成的 Grounding 搜索已被抛弃/);
});

test('VSearch retries transient Grok failures and truncates stream before plugin timeout', () => {
  assert.match(source, /GROK_MAX_RETRIES = 3/);
  assert.match(source, /GROK_BASE_RETRY_DELAY_MS/);
  assert.match(source, /isGrokRetryableError/);
  assert.match(source, /message\.includes\('503'\)/);
  assert.match(source, /message\.includes\('empty'\)/);
  assert.match(source, /message\.includes\('空响应'\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /Grok 流式输出已截断/);
});
