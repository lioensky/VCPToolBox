'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../modules/finalContextStore');

test('final context blocks use the local CJK-weighted estimate and count tool definitions', () => {
  store.clearFinalContexts();
  store.setLastFinalContext({
    model: 'm',
    messages: [{ role: 'system', content: '你好世界' }, { role: 'user', content: 'abcdef' }],
    tools: [{ type: 'function', function: { name: 'x' } }]
  }, { requestId: 'r-estimate' });
  const { summary } = store.getLastFinalContext();
  assert.equal(summary.blocks[0].tokenCount, 3);
  assert.equal(summary.blocks[1].tokenCount, 2);
  assert.ok(summary.toolsTokenCount > 0);
  assert.equal(summary.totalTokenCount, 5 + summary.toolsTokenCount);
  assert.equal(summary.tokenMethod, 'estimate:cjk2/3');
  assert.equal(summary.upstreamUsage, null);
});

test('upstream usage attaches to the matching snapshot once', () => {
  store.clearFinalContexts();
  store.setLastFinalContext({ messages: [{ role: 'user', content: 'a' }] }, { requestId: 'r1' });
  store.setLastFinalContext({ messages: [{ role: 'user', content: 'b' }] }, { requestId: 'r2' });
  assert.equal(store.recordUpstreamUsage('r1', { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 800 } }), true);
  assert.equal(store.recordUpstreamUsage('r1', { prompt_tokens: 99999 }), false);
  assert.equal(store.recordUpstreamUsage('r2', { completion_tokens: 3 }), false);
  assert.equal(store.recordUpstreamUsage('missing', { prompt_tokens: 5 }), false);
  const [latest, first] = store.listFinalContexts();
  assert.equal(latest.summary.upstreamUsage, null);
  assert.deepEqual(first.summary.upstreamUsage, { promptTokens: 1200, completionTokens: 30, cachedTokens: 800 });
});
