const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SemanticModelRouter = require('../modules/semanticModelRouter');
const {
  mergeConfig,
  normalizeConfig,
  readLayeredConfig,
  resolveLocalConfigPath,
  writeLocalConfig,
} = require('../modules/semanticRouterConfig');

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

function closeRouterWatchers(router) {
  router.closeWatchers();
  assert.equal(router.reloadTimer, null);
  assert.deepEqual(router.watchHandles, []);
}

async function waitFor(assertion, timeoutMs = 3000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (lastError) throw lastError;
}

test('semantic router config deep-merges preset overrides and replaces arrays', () => {
  const merged = mergeConfig(
    {
      enabled: true,
      featureFlags: {
        baseOnly: true,
        shared: 'base',
      },
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          defaultModel: 'base-model',
          fallbackModels: ['base-fallback'],
          routes: [
            {
              name: 'base',
              model: 'base-route',
              description: 'base route',
            },
          ],
        },
      },
    },
    {
      featureFlags: {
        shared: 'local',
      },
      presets: {
        default: {
          defaultModel: 'local-model',
          fallbackModels: ['local-fallback-1', 'local-fallback-2'],
        },
      },
    }
  );

  assert.equal(merged.enabled, true);
  assert.deepEqual(merged.contextWeights, [0.7, 0.3]);
  assert.deepEqual(merged.featureFlags, {
    baseOnly: true,
    shared: 'local',
  });
  assert.equal(merged.presets.default.defaultModel, 'local-model');
  assert.deepEqual(merged.presets.default.fallbackModels, ['local-fallback-1', 'local-fallback-2']);
  assert.deepEqual(merged.presets.default.routes, [
    {
      name: 'base',
      model: 'base-route',
      description: 'base route',
    },
  ]);
});

test('semantic router local config can remove presets from base config with tombstones', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-remove-preset-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'default-model',
          fallbackModels: [],
          routes: [],
        },
        VCPModelCoding: {
          displayName: 'Coding',
          defaultModel: 'coding-model',
          fallbackModels: [],
          routes: [
            {
              name: 'coding',
              model: 'coding-model',
              description: 'coding tasks',
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  await writeLocalConfig(configPath, {
    deletedPresets: ['VCPModelCoding'],
    enabled: true,
    autoModelName: 'VCPModelAuto',
    defaultPreset: 'default',
    matchThreshold: 0.18,
    contextWeights: [0.7, 0.3],
    presets: {
      default: {
        displayName: 'VCPModelAuto',
        defaultModel: 'local-default-model',
        fallbackModels: [],
        routes: [],
      },
    },
  });

  const layered = await readLayeredConfig(configPath);
  assert.equal(layered.usesLocalConfig, true);
  assert.deepEqual(Object.keys(layered.mergedConfig.presets), ['default']);
  assert.deepEqual(layered.mergedConfig.deletedPresets, ['VCPModelCoding']);
  assert.equal(layered.config.presets.default.defaultModel, 'local-default-model');
  assert.equal(layered.config.presets.VCPModelCoding, undefined);

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.equal(router.config.presets.VCPModelCoding, undefined);
  assert.equal(router.isRoutingModel('VCPModelCoding'), false);
  assert.deepEqual(
    router.getVirtualModels().map(model => model.id),
    ['VCPModelAuto']
  );

  closeRouterWatchers(router);
});

test('semantic router local config deep-merges partial preset overrides', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-partial-preset-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'base-model',
          fallbackModels: ['base-fallback'],
          routes: [
            {
              name: 'coding',
              model: 'coding-model',
              description: 'coding tasks',
            },
          ],
        },
        VCPModelCreative: {
          displayName: 'Creative',
          defaultModel: 'creative-model',
          fallbackModels: [],
          routes: [
            {
              name: 'creative',
              model: 'creative-model',
              description: 'creative tasks',
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  await writeLocalConfig(configPath, {
    presets: {
      default: {
        defaultModel: 'local-model',
      },
    },
  });

  const layered = await readLayeredConfig(configPath);
  assert.equal(layered.config.presets.default.defaultModel, 'local-model');
  assert.deepEqual(layered.config.presets.default.fallbackModels, ['base-fallback']);
  assert.equal(layered.config.presets.default.routes[0].model, 'coding-model');
  assert.equal(layered.config.presets.VCPModelCreative.defaultModel, 'creative-model');

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.equal(router.config.presets.default.routes[0].model, 'coding-model');
  assert.equal(router.isRoutingModel('VCPModelCreative'), true);

  closeRouterWatchers(router);
});

test('SemanticModelRouter loads ignored local override next to base config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-local-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'base-model',
          fallbackModels: ['base-fallback'],
          routes: [
            {
              name: 'base',
              model: 'base-route',
              description: 'base route description',
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  await writeLocalConfig(configPath, {
    presets: {
      default: {
        defaultModel: 'local-model',
        fallbackModels: ['local-fallback'],
        routes: [
          {
            name: 'local',
            model: 'local-route',
            description: 'local route description',
          },
        ],
      },
    },
  });

  const layered = await readLayeredConfig(configPath);
  assert.equal(layered.hasLocalConfig, true);
  assert.equal(layered.localConfigPath, resolveLocalConfigPath(configPath));
  assert.equal(layered.config.presets.default.defaultModel, 'local-model');
  assert.deepEqual(layered.config.presets.default.fallbackModels, ['local-fallback']);
  assert.equal(layered.config.presets.default.routes[0].model, 'local-route');

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.equal(router.config.presets.default.defaultModel, 'local-model');
  assert.deepEqual(router.config.presets.default.fallbackModels, ['local-fallback']);
  assert.equal(router.config.presets.default.routes[0].model, 'local-route');

  closeRouterWatchers(router);
});

test('SemanticModelRouter keeps one directory watcher for base and local config changes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-watch-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'base-model',
          fallbackModels: [],
          routes: [
            {
              name: 'base',
              model: 'base-route',
              description: 'base route description',
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.deepEqual(
    router.watchHandles.map(watcher => ({ type: watcher.type, path: watcher.path })),
    [{ type: 'directory', path: tempDir }]
  );

  await writeLocalConfig(configPath, {
    presets: {
      default: {
        defaultModel: 'local-model',
      },
    },
  });
  await router.loadConfig();
  router.startWatcher();

  assert.equal(router.config.presets.default.defaultModel, 'local-model');
  assert.equal(router.watchHandles.length, 1);

  closeRouterWatchers(router);
});

test('SemanticModelRouter reloads when local config is deleted and recreated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-recreate-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');
  const localConfigPath = resolveLocalConfigPath(configPath);

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'base-model',
          fallbackModels: [],
          routes: [
            {
              name: 'base',
              model: 'base-route',
              description: 'base route description',
            },
          ],
        },
      },
    }),
    'utf-8'
  );

  await writeLocalConfig(configPath, {
    presets: {
      default: {
        defaultModel: 'local-one',
      },
    },
  });

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.equal(router.config.presets.default.defaultModel, 'local-one');

  await fs.rm(localConfigPath);
  await waitFor(() => {
    assert.equal(router.config.presets.default.defaultModel, 'base-model');
  });

  await writeLocalConfig(configPath, {
    presets: {
      default: {
        defaultModel: 'local-two',
      },
    },
  });
  await waitFor(() => {
    assert.equal(router.config.presets.default.defaultModel, 'local-two');
  });

  closeRouterWatchers(router);
});

test('SemanticModelRouter falls back to base config when local config is invalid', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-router-invalid-local-'));
  const configPath = path.join(tempDir, 'SemanticModelRouter.json');
  const localConfigPath = resolveLocalConfigPath(configPath);

  await fs.writeFile(
    configPath,
    JSON.stringify({
      enabled: true,
      autoModelName: 'VCPModelAuto',
      defaultPreset: 'default',
      matchThreshold: 0.18,
      contextWeights: [0.7, 0.3],
      presets: {
        default: {
          displayName: 'VCPModelAuto',
          defaultModel: 'base-model',
          fallbackModels: ['base-fallback'],
          routes: [
            {
              name: 'base',
              model: 'base-route',
              description: 'base route description',
            },
          ],
        },
      },
    }),
    'utf-8'
  );
  await fs.writeFile(localConfigPath, '{ invalid json', 'utf-8');

  const layered = await readLayeredConfig(configPath);
  assert.equal(layered.hasLocalConfig, true);
  assert.equal(layered.usesLocalConfig, false);
  assert.equal(layered.config.presets.default.defaultModel, 'base-model');
  assert.equal(layered.config.presets.default.routes[0].model, 'base-route');
  assert.equal(layered.localConfigError.name, 'SyntaxError');
  assert.equal(typeof layered.localConfigError.message, 'string');
  assert.notEqual(layered.localConfigError.message.length, 0);

  const router = new SemanticModelRouter();
  await router.initialize(configPath, false);
  assert.equal(router.config.presets.default.defaultModel, 'base-model');
  assert.equal(router.config.presets.default.routes[0].model, 'base-route');

  closeRouterWatchers(router);
});

test('semantic router config can preserve disabled routes for admin editing', () => {
  const rawConfig = {
    presets: {
      default: {
        defaultModel: 'default-model',
        routes: [
          {
            name: 'disabled',
            model: 'disabled-model',
            description: 'temporarily disabled route',
            enabled: false,
          },
          {
            name: 'enabled',
            model: 'enabled-model',
            description: 'enabled route',
          },
        ],
      },
    },
  };

  assert.deepEqual(
    normalizeConfig(rawConfig).presets.default.routes.map(route => route.name),
    ['enabled']
  );
  assert.deepEqual(
    normalizeConfig(rawConfig, { includeDisabledRoutes: true }).presets.default.routes.map(route => route.name),
    ['disabled', 'enabled']
  );
});

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
