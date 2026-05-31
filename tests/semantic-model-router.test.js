const test = require('node:test');
const assert = require('node:assert/strict');

const SemanticModelRouter = require('../modules/semanticModelRouter');

function createPluginManager(ragPlugin) {
  return {
    messagePreprocessors: new Map([
      ['RAGDiaryPlugin', ragPlugin],
    ]),
  };
}

function createVectorRagPlugin(vectorByText) {
  return {
    async getSingleEmbeddingCached(text) {
      return vectorByText.get(text) || null;
    },
    _getWeightedAverageVector(vectors) {
      return vectors.find(Boolean) || null;
    },
    vectorDBManager: {
      async getPluginDescriptionVector(description, fallback) {
        return vectorByText.get(description) || fallback(description);
      },
    },
  };
}

test('SemanticModelRouter excludes failoverPool false routes from another route fallback chain', async () => {
  const router = new SemanticModelRouter();
  router.config = router.normalizeConfig({
    enabled: true,
    autoModelName: 'VCPModelAuto',
    defaultPreset: 'default',
    matchThreshold: 0.8,
    contextWeights: [1, 0],
    presets: {
      default: {
        defaultModel: 'default-model',
        fallbackModels: ['fallback-model'],
        routes: [
          {
            name: 'primary',
            model: 'primary-model',
            description: 'primary route',
          },
          {
            name: 'pool',
            model: 'pool-model',
            description: 'pool route',
          },
          {
            name: 'private',
            model: 'private-model',
            description: 'private route',
            failoverPool: false,
          },
        ],
      },
    },
  });

  const ragPlugin = createVectorRagPlugin(new Map([
    ['user request', [1, 0]],
    ['primary route', [1, 0]],
    ['pool route', [0.9, 0.1]],
    ['private route', [0.95, 0.05]],
  ]));

  const plan = await router.resolveRoute({
    requestedModel: 'VCPModelAuto',
    messages: [{ role: 'user', content: 'user request' }],
    pluginManager: createPluginManager(ragPlugin),
  });

  assert.equal(plan.reason, 'semantic_match');
  assert.equal(plan.selectedModel, 'primary-model');
  assert.deepEqual(plan.candidates, [
    'primary-model',
    'pool-model',
    'default-model',
    'fallback-model',
  ]);
});

test('SemanticModelRouter stops route fallback expansion when primary failoverPool is false', async () => {
  const router = new SemanticModelRouter();
  router.config = router.normalizeConfig({
    enabled: true,
    autoModelName: 'VCPModelAuto',
    defaultPreset: 'default',
    matchThreshold: 0.8,
    contextWeights: [1, 0],
    presets: {
      default: {
        defaultModel: 'default-model',
        fallbackModels: ['fallback-model'],
        routes: [
          {
            name: 'primary',
            model: 'primary-model',
            description: 'primary route',
            failoverPool: false,
          },
          {
            name: 'secondary',
            model: 'secondary-model',
            description: 'secondary route',
          },
        ],
      },
    },
  });

  const ragPlugin = createVectorRagPlugin(new Map([
    ['user request', [1, 0]],
    ['primary route', [1, 0]],
    ['secondary route', [0.95, 0.05]],
  ]));

  const plan = await router.resolveRoute({
    requestedModel: 'VCPModelAuto',
    messages: [{ role: 'user', content: 'user request' }],
    pluginManager: createPluginManager(ragPlugin),
  });

  assert.equal(plan.reason, 'semantic_match');
  assert.equal(plan.selectedModel, 'primary-model');
  assert.deepEqual(plan.candidates, [
    'primary-model',
    'default-model',
    'fallback-model',
  ]);
});
