const test = require('node:test');
const assert = require('node:assert/strict');

const sarPromptManager = require('../modules/sarPromptManager.js');
const messageProcessor = require('../modules/messageProcessor.js');

function withPrompts(prompts, callback) {
  const previousPrompts = sarPromptManager.prompts;
  sarPromptManager.prompts = prompts;

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      sarPromptManager.prompts = previousPrompts;
    });
}

test('isModelMatch supports exact and includes matching', () => {
  assert.equal(sarPromptManager.isModelMatch(['gpt-5.6'], 'gpt-5.6', 'exact'), true);
  assert.equal(sarPromptManager.isModelMatch(['gpt-5.6'], 'gpt-5.6-mini', 'exact'), false);
  assert.equal(sarPromptManager.isModelMatch(['gpt'], 'gpt-5.6', 'includes'), true);
  assert.equal(sarPromptManager.isModelMatch(['gpt'], 'claude-4', 'includes'), false);
});

test('isModelMatch supports exact and includes exclusion', () => {
  assert.equal(sarPromptManager.isModelMatch(['gpt-5.6'], 'gpt-5.6', 'exactExclude'), false);
  assert.equal(sarPromptManager.isModelMatch(['gpt-5.6'], 'gpt-5.6-mini', 'exactExclude'), true);
  assert.equal(sarPromptManager.isModelMatch(['gpt'], 'gpt-5.6', 'includesExclude'), false);
  assert.equal(sarPromptManager.isModelMatch(['gpt'], 'claude-4', 'includesExclude'), true);
});

test('isModelMatch preserves normalization and rejects empty model lists', () => {
  assert.equal(
    sarPromptManager.isModelMatch(['  GPT-5.6  '].map(model => model.trim().toLowerCase()), 'gpt-5.6', 'exact'),
    true
  );
  assert.equal(sarPromptManager.isModelMatch([], 'gpt-5.6', 'exactExclude'), false);
  assert.equal(
    sarPromptManager.isModelMatch(['', '  '].map(model => model.trim().toLowerCase()), 'gpt-5.6', 'includesExclude'),
    false
  );
});

test('getSarPrompt defaults missing matchMode to exact and preserves group order', async () => {
  await withPrompts([
    { promptKey: 'SarPrompt1', models: ['GPT-5.6'], content: 'first' },
    { promptKey: 'SarPrompt2', models: ['GPT'], content: 'second', matchMode: 'includes' }
  ], () => {
    assert.equal(sarPromptManager.getSarPrompt('GPT-5.6').promptKey, 'SarPrompt1');
    assert.equal(sarPromptManager.getSarPrompt('GPT-5.6-mini').promptKey, 'SarPrompt2');
    assert.equal(sarPromptManager.getSarPrompt('Claude-4'), null);
  });
});

test('getSarPrompt does not activate an empty exclusion group', async () => {
  await withPrompts([
    { promptKey: 'SarPrompt1', models: [], content: 'excluded all', matchMode: 'includesExclude' }
  ], () => {
    assert.equal(sarPromptManager.getSarPrompt('Claude-4'), null);
  });
});

test('SarPrompt placeholders use the same exclusion semantics', async () => {
  await withPrompts([
    { promptKey: 'SarPrompt1', models: ['GPT'], content: 'not for GPT', matchMode: 'includesExclude' },
    { promptKey: 'SarPrompt2', models: ['Claude-4'], content: 'for Claude', matchMode: 'exact' }
  ], async () => {
    const context = {
      pluginManager: {
        plugins: new Map(),
        getAllPlaceholderValues() {
          return new Map();
        },
        getIndividualPluginDescriptions() {
          return new Map();
        },
        getResolvedPluginConfigValue() {
          return undefined;
        }
      },
      cachedEmojiLists: new Map(),
      DEBUG_MODE: false
    };

    const singleExcluded = await messageProcessor.replaceOtherVariables(
      '{{SarPrompt1}}',
      'GPT-5.6',
      'system',
      context
    );
    const singleIncluded = await messageProcessor.replaceOtherVariables(
      '{{SarPrompt1}}',
      'Claude-4',
      'system',
      context
    );
    const allIncluded = await messageProcessor.replaceOtherVariables(
      '{{SarPromptAll}}',
      'Claude-4',
      'system',
      context
    );
    const allExcluded = await messageProcessor.replaceOtherVariables(
      '{{SarPromptAll}}',
      'GPT-5.6',
      'system',
      context
    );

    assert.equal(singleExcluded, '');
    assert.equal(singleIncluded, 'not for GPT');
    assert.equal(allIncluded, 'not for GPT\nfor Claude');
    assert.equal(allExcluded, '');
  });
});
