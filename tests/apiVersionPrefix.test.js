'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveApiVersionPrefix } = require('../core/upstreamFetch.js');

test('resolveApiVersionPrefix 智能解析测试', async (t) => {
  await t.test('显式前缀优先，且自动去除首尾斜杠', () => {
    assert.equal(resolveApiVersionPrefix('https://api.openai.com', '/v1/'), 'v1');
    assert.equal(resolveApiVersionPrefix('https://generativelanguage.googleapis.com', 'v1beta/openai/'), 'v1beta/openai');
    assert.equal(resolveApiVersionPrefix('https://open.bigmodel.cn/api/paas', '/v4'), 'v4');
  });

  await t.test('Google Gemini 域名自动解析为 v1beta/openai', () => {
    assert.equal(resolveApiVersionPrefix('https://generativelanguage.googleapis.com'), 'v1beta/openai');
    assert.equal(resolveApiVersionPrefix('https://generativelanguage.googleapis.com/'), 'v1beta/openai');
    assert.equal(resolveApiVersionPrefix('https://my-google-proxy.example.com'), 'v1beta/openai');
  });

  await t.test('智谱 GLM 域名自动解析为 v4', () => {
    assert.equal(resolveApiVersionPrefix('https://open.bigmodel.cn/api/paas'), 'v4');
    assert.equal(resolveApiVersionPrefix('https://api.zhipu.ai'), 'v4');
  });

  await t.test('标准 OpenAI / DeepSeek / 自建中转默认回退到 v1', () => {
    assert.equal(resolveApiVersionPrefix('https://api.openai.com'), 'v1');
    assert.equal(resolveApiVersionPrefix('https://api.deepseek.com'), 'v1');
    assert.equal(resolveApiVersionPrefix('https://my-one-api.local:3000'), 'v1');
    assert.equal(resolveApiVersionPrefix(''), 'v1');
    assert.equal(resolveApiVersionPrefix(null), 'v1');
  });
});
