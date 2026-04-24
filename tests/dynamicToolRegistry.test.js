const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const dynamicToolRegistryModule = require('../modules/dynamicToolRegistry.js');
const { DynamicToolRegistry } = dynamicToolRegistryModule;
const messageProcessor = require('../modules/messageProcessor.js');

async function makeProjectRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-dynamic-tools-'));
  await fs.mkdir(path.join(root, 'ToolConfigs'), { recursive: true });
  return root;
}

function makeManifest(name, description, options = {}) {
  return {
    name,
    displayName: options.displayName || name,
    description,
    pluginType: options.pluginType || 'synchronous',
    entryPoint: options.entryPoint || { script: `${name}.js` },
    isDistributed: Boolean(options.serverId),
    serverId: options.serverId,
    capabilities: {
      invocationCommands: [
        {
          command: options.command || name,
          commandIdentifier: options.commandIdentifier || name,
          description: options.commandDescription || description,
          example: options.example || `tool_name: ${name}`
        }
      ]
    }
  };
}

function makePluginManager(manifests) {
  const plugins = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  return {
    plugins,
    getIndividualPluginDescriptions() {
      const descriptions = new Map();
      for (const manifest of plugins.values()) {
        descriptions.set(`VCP${manifest.name}`, `FULL:${manifest.name}:${manifest.capabilities.invocationCommands[0].description}`);
      }
      return descriptions;
    },
    getAllPlaceholderValues() {
      return new Map();
    },
    getResolvedPluginConfigValue() {
      return undefined;
    }
  };
}

class EventedPluginManager extends EventEmitter {
  constructor(manifests) {
    super();
    this.plugins = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  }

  getIndividualPluginDescriptions() {
    const descriptions = new Map();
    for (const manifest of this.plugins.values()) {
      descriptions.set(`VCP${manifest.name}`, `FULL:${manifest.name}:${manifest.capabilities.invocationCommands[0].description}`);
    }
    return descriptions;
  }

  getAllPlaceholderValues() {
    return new Map();
  }

  getResolvedPluginConfigValue() {
    return undefined;
  }
}

function classifierFactory(calls) {
  return async (record) => {
    calls.push({ originKey: record.originKey, sourceHash: record.sourceHash });
    const lower = `${record.pluginName} ${record.description} ${record.fullDescription}`.toLowerCase();
    if (lower.includes('search') || lower.includes('web')) {
      return {
        categories: ['search'],
        keywords: ['search', 'web', 'lookup'],
        brief: `${record.pluginName} searches web resources.`,
        confidence: 0.9,
        classifiedBy: 'test_classifier'
      };
    }
    if (lower.includes('file') || lower.includes('code')) {
      return {
        categories: ['file_code'],
        keywords: ['file', 'code', 'read'],
        brief: `${record.pluginName} works with files and code.`,
        confidence: 0.9,
        classifiedBy: 'test_classifier'
      };
    }
    return {
      categories: ['general'],
      keywords: ['tool'],
      brief: `${record.pluginName} provides a general VCP tool.`,
      confidence: 0.5,
      classifiedBy: 'test_classifier'
    };
  };
}

function testConfig(overrides = {}) {
  return {
    enabled: true,
    classificationDebounceMs: 0,
    classifierTimeoutMs: 500,
    maxBriefListItems: 20,
    maxExpandedPlugins: 1,
    maxForcedCategoryPlugins: 10,
    maxInjectionChars: 8000,
    ...overrides
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('sync classifies only new or changed plugin sources and preserves disabled cache', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const searchV1 = makeManifest('SearchTool', 'Search the web and lookup public references.');
  const pluginManager = makePluginManager([searchV1]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory(calls)
  });

  await registry.syncFromPluginManager('initial');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 1);

  pluginManager.plugins.delete('SearchTool');
  await registry.syncFromPluginManager('disabled');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 1, 'disable/remove must not reclassify historical metadata');
  assert.equal(registry.getRecord('local:SearchTool').available, false);

  pluginManager.plugins.set('SearchTool', searchV1);
  await registry.syncFromPluginManager('reenabled');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 1, 'reenable with same source hash must reuse cached classification');
  assert.equal(registry.getRecord('local:SearchTool').available, true);

  const searchV2 = makeManifest('SearchTool', 'Search the web, news, and academic references.');
  pluginManager.plugins.set('SearchTool', searchV2);
  await registry.syncFromPluginManager('changed');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 2, 'source hash change must reclassify exactly once');
});

test('manual rebuild can run classification in the background without waiting', async () => {
  const projectRoot = await makeProjectRoot();
  const blocker = createDeferred();
  const calls = [];
  const pluginManager = makePluginManager([
    makeManifest('SlowSearch', 'Search the web with a slow classifier.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig({ classificationDebounceMs: 60000 }),
    classifier: async (record) => {
      calls.push(record.pluginName);
      await blocker.promise;
      return {
        categories: ['search'],
        keywords: ['search'],
        brief: `${record.pluginName} searches resources.`,
        confidence: 0.9
      };
    }
  });

  await registry.syncFromPluginManager('seed_catalog');
  const startedAt = Date.now();
  const state = await registry.forceRebuild({ mode: 'classification', wait: false });

  assert.ok(Date.now() - startedAt < 100, 'background rebuild should return before classification finishes');
  assert.equal(state.isClassifying, true);
  assert.deepEqual(calls, ['SlowSearch']);

  blocker.resolve();
  await registry.flushClassificationQueue();
  const finalState = registry.getAdminState();
  assert.equal(finalState.isClassifying, false);
  assert.equal(finalState.records[0].classifiedBy, 'custom_classifier');
});

test('sync queue recovers after one failed sync write', async () => {
  const projectRoot = await makeProjectRoot();
  const pluginManager = makePluginManager([
    makeManifest('SearchTool', 'Search the web and lookup public references.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory([])
  });

  const originalWriteCatalog = registry._writeCatalog.bind(registry);
  let failedOnce = false;
  registry._writeCatalog = async () => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('simulated catalog write failure');
    }
    return originalWriteCatalog();
  };

  await assert.rejects(
    registry.syncFromPluginManager('first_failure'),
    /simulated catalog write failure/
  );

  await registry.syncFromPluginManager('second_success');
  await registry.flushClassificationQueue();
  assert.equal(registry.getRecord('local:SearchTool').available, true);
});

test('write queue recovers after one failed atomic write', async () => {
  const projectRoot = await makeProjectRoot();
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager: makePluginManager([]),
    projectBasePath: projectRoot,
    config: testConfig()
  });

  const originalWriteJsonAtomic = registry._writeJsonAtomic.bind(registry);
  let failedOnce = false;
  registry._writeJsonAtomic = async (...args) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('simulated atomic write failure');
    }
    return originalWriteJsonAtomic(...args);
  };

  await assert.rejects(
    registry.updateConfig({ maxBriefListItems: 10 }),
    /simulated atomic write failure/
  );

  const saved = await registry.updateConfig({ maxBriefListItems: 11 });
  assert.equal(saved.maxBriefListItems, 11);
  const configPath = path.join(projectRoot, 'ToolConfigs', 'dynamic_tool_bridge.config.json');
  const diskConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(diskConfig.maxBriefListItems, 11);
});

test('distributed offline state excludes tools while reconnect reuses classification cache', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const distributed = makeManifest('RemoteSearch', 'Remote search service for web lookup.', { serverId: 'srv-a' });
  const pluginManager = makePluginManager([distributed]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory(calls)
  });

  await registry.syncFromPluginManager('distributed_register');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 1);
  assert.equal(registry.getRecord('distributed:srv-a:RemoteSearch').available, true);

  await registry.markDistributedOffline('srv-a');
  assert.equal(registry.getRecord('distributed:srv-a:RemoteSearch').available, false);
  const offlineInjection = await registry.buildInjection({
    messages: [{ role: 'user', content: 'Please search the web.' }],
    pluginManager
  });
  assert.equal(offlineInjection.includes('FULL:RemoteSearch'), false);

  await registry.syncFromPluginManager('distributed_reconnect');
  await registry.flushClassificationQueue();
  assert.equal(calls.length, 1, 'distributed reconnect with same source hash must not reclassify');
  assert.equal(registry.getRecord('distributed:srv-a:RemoteSearch').available, true);
});

test('buildInjection exposes brief list, relevant full descriptions, and explicit directives', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const pluginManager = makePluginManager([
    makeManifest('SearchTool', 'Search the web and lookup public references.'),
    makeManifest('ScholarSearch', 'Academic web search for papers and citations.'),
    makeManifest('FileTool', 'Read and inspect local code files.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig({ maxExpandedPlugins: 1 }),
    classifier: classifierFactory(calls)
  });
  await registry.syncFromPluginManager('initial');
  await registry.flushClassificationQueue();

  const relevant = await registry.buildInjection({
    messages: [{ role: 'user', content: 'Need to search the web for references.' }],
    pluginManager
  });
  assert.match(relevant, /SearchTool/);
  assert.match(relevant, /ScholarSearch/);
  assert.match(relevant, /FULL:(SearchTool|ScholarSearch)/);
  assert.equal(relevant.includes('FULL:FileTool'), false);

  const forcedCategory = await registry.buildInjection({
    messages: [{ role: 'assistant', content: '[[VCPDynamicTools:category=search:all]]' }],
    pluginManager
  });
  assert.match(forcedCategory, /FULL:SearchTool/);
  assert.match(forcedCategory, /FULL:ScholarSearch/);

  const forcedTool = await registry.buildInjection({
    messages: [{ role: 'assistant', content: '[[VCPDynamicTools:tool=FileTool]]' }],
    pluginManager
  });
  assert.match(forcedTool, /FULL:FileTool/);

  const naturalTool = await registry.buildInjection({
    messages: [{ role: 'assistant', content: 'Please expand full details for FileTool.' }],
    pluginManager
  });
  assert.match(naturalTool, /FULL:FileTool/);

  const naturalCategory = await registry.buildInjection({
    messages: [{ role: 'assistant', content: 'Please show full search category tools.' }],
    pluginManager
  });
  assert.match(naturalCategory, /FULL:SearchTool/);
  assert.match(naturalCategory, /FULL:ScholarSearch/);

  const weakMention = await registry.buildInjection({
    messages: [{ role: 'user', content: 'I may need search across all references.' }],
    pluginManager
  });
  assert.equal(
    weakMention.includes('FULL:SearchTool') && weakMention.includes('FULL:ScholarSearch'),
    false,
    'weak category mentions must not force-expand the whole category'
  );
});

test('buildInjection keeps verbose classifier briefs compact in the light list', async () => {
  const projectRoot = await makeProjectRoot();
  const pluginManager = makePluginManager([
    makeManifest('VerboseSearch', 'Search the web with a long operational description.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: async () => ({
      categories: ['search'],
      keywords: ['search'],
      brief: 'Searches public web references with an excessively verbose multi stage explanation that would waste context in large tool lists.',
      confidence: 0.9
    })
  });
  await registry.syncFromPluginManager('compact_brief_list');
  await registry.flushClassificationQueue();

  const injection = await registry.buildInjection({
    messages: [{ role: 'user', content: 'search the web' }],
    pluginManager
  });
  const line = injection.split('\n').find((item) => item.includes('VerboseSearch') && item.includes('[search]'));

  assert.ok(line, 'expected the verbose tool to appear in the light list');
  assert.equal(line.includes('multi stage explanation'), false);
  assert.ok(line.length <= 110, `light list entry should stay compact, got ${line.length} chars: ${line}`);
});

test('messageProcessor replaces VCPDynamicTools without changing VCPAllTools behavior', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const pluginManager = makePluginManager([
    makeManifest('SearchTool', 'Search the web and lookup public references.')
  ]);

  await dynamicToolRegistryModule.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory(calls)
  });
  await dynamicToolRegistryModule.syncFromPluginManager('message_processor');
  await dynamicToolRegistryModule.flushClassificationQueue();

  const output = await messageProcessor.replaceOtherVariables(
    '{{VCPDynamicTools}}\n---\n{{VCPAllTools}}',
    'test-model',
    'system',
    {
      pluginManager,
      cachedEmojiLists: new Map(),
      detectors: [],
      superDetectors: [],
      DEBUG_MODE: false,
      messages: [{ role: 'user', content: 'search the web' }]
    }
  );

  assert.match(output, /Dynamic VCP Tools/);
  assert.match(output, /SearchTool/);
  assert.match(output, /FULL:SearchTool/);
  assert.equal(output.includes('{{VCPAllTools}}'), false);
});

test('concurrent sync and injection keep cache files valid JSON', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const pluginManager = makePluginManager([
    makeManifest('SearchTool', 'Search the web and lookup public references.'),
    makeManifest('FileTool', 'Read and inspect local code files.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory(calls)
  });

  await Promise.all([
    registry.syncFromPluginManager('concurrent-a'),
    registry.syncFromPluginManager('concurrent-b'),
    registry.buildInjection({ messages: [{ role: 'user', content: 'search files' }], pluginManager })
  ]);
  await registry.flushClassificationQueue();

  const catalogPath = path.join(projectRoot, 'ToolConfigs', 'dynamic_tool_catalog.json');
  const categoriesPath = path.join(projectRoot, 'ToolConfigs', 'dynamic_tool_categories.json');
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const categories = JSON.parse(await fs.readFile(categoriesPath, 'utf8'));
  assert.ok(catalog.plugins['local:SearchTool']);
  assert.ok(categories.items['local:SearchTool']);
});

test('corrupt cache files are ignored and rebuilt as valid JSON', async () => {
  const projectRoot = await makeProjectRoot();
  const toolConfigsDir = path.join(projectRoot, 'ToolConfigs');
  await fs.writeFile(path.join(toolConfigsDir, 'dynamic_tool_catalog.json'), '{"plugins":', 'utf8');
  await fs.writeFile(path.join(toolConfigsDir, 'dynamic_tool_categories.json'), '{"items":', 'utf8');

  const pluginManager = makePluginManager([
    makeManifest('SearchTool', 'Search the web and lookup public references.')
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig(),
    classifier: classifierFactory([])
  });
  await registry.syncFromPluginManager('corrupt_cache_rebuild');
  await registry.flushClassificationQueue();

  const catalog = JSON.parse(await fs.readFile(path.join(toolConfigsDir, 'dynamic_tool_catalog.json'), 'utf8'));
  const categories = JSON.parse(await fs.readFile(path.join(toolConfigsDir, 'dynamic_tool_categories.json'), 'utf8'));
  assert.ok(catalog.plugins['local:SearchTool']);
  assert.ok(categories.items['local:SearchTool']);
});

test('PluginManager events trigger sync and distributed offline exclusion', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  const pluginManager = new EventedPluginManager([
    makeManifest('RemoteSearch', 'Remote search service for web lookup.', { serverId: 'srv-event' })
  ]);
  const registry = new DynamicToolRegistry();

  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig({ classificationDebounceMs: 0 }),
    classifier: classifierFactory(calls)
  });

  pluginManager.emit('tools_changed', { reason: 'distributed_register', serverId: 'srv-event' });
  await registry.syncPromise;
  await registry.flushClassificationQueue();
  assert.equal(registry.getRecord('distributed:srv-event:RemoteSearch').available, true);

  pluginManager.emit('distributed_tools_offline', { serverId: 'srv-event' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.getRecord('distributed:srv-event:RemoteSearch').available, false);
});

test('fast distributed register/unregister preserves an offline catalog record', async () => {
  const projectRoot = await makeProjectRoot();
  const calls = [];
  class FastDisconnectPluginManager extends EventedPluginManager {
    registerDistributedTools(serverId, tools) {
      for (const tool of tools) {
        tool.isDistributed = true;
        tool.serverId = serverId;
        this.plugins.set(tool.name, tool);
      }
      this.emit('tools_changed', { reason: 'distributed_register', serverId });
    }

    unregisterAllDistributedTools(serverId) {
      const manifests = [];
      for (const [name, manifest] of this.plugins.entries()) {
        if (manifest.isDistributed && manifest.serverId === serverId) {
          manifests.push({ ...manifest });
          this.plugins.delete(name);
        }
      }
      this.emit('distributed_tools_offline', {
        serverId,
        pluginNames: manifests.map((manifest) => manifest.name),
        manifests
      });
      this.emit('tools_changed', { reason: 'distributed_unregister', serverId });
    }
  }

  const pluginManager = new FastDisconnectPluginManager([]);
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig({ classificationDebounceMs: 0 }),
    classifier: classifierFactory(calls)
  });

  const manifest = makeManifest('RaceRemoteSearch', 'Remote search service for web lookup.', { serverId: 'race-srv' });
  pluginManager.registerDistributedTools('race-srv', [manifest]);
  pluginManager.unregisterAllDistributedTools('race-srv');

  await registry.syncPromise;
  await registry.flushClassificationQueue();

  const record = registry.getRecord('distributed:race-srv:RaceRemoteSearch');
  assert.ok(record, 'fast disconnect should still leave an offline historical record');
  assert.equal(record.available, false);
  assert.equal(record.online, false);
  assert.equal(calls.length, 1, 'the disconnected tool should have been classified once for cache reuse');
});

test('classification uses RAG embedding fallback when no small model or classifier is configured', async () => {
  const projectRoot = await makeProjectRoot();
  const pluginManager = makePluginManager([
    makeManifest('SemanticSearch', 'Search web references with semantic retrieval.')
  ]);
  pluginManager.messagePreprocessors = new Map([
    ['RAGDiaryPlugin', {
      async getSingleEmbedding(text) {
        const lower = String(text).toLowerCase();
        if (lower.includes('search') || lower.includes('web') || lower.includes('retrieval')) return [1, 0];
        if (lower.includes('file') || lower.includes('code')) return [0, 1];
        return [0.1, 0.1];
      }
    }]
  ]);

  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig({ useRagEmbeddings: true })
  });

  await registry.syncFromPluginManager('embedding_fallback');
  await registry.flushClassificationQueue();

  const state = registry.getAdminState();
  const item = state.records.find((record) => record.pluginName === 'SemanticSearch');
  assert.ok(item.categories.includes('search'));
  assert.equal(item.classifiedBy, 'rag_embedding_fallback');
});

test('small model reads private plugin config without leaking api key', async (t) => {
  const projectRoot = await makeProjectRoot();
  const privateConfigDir = path.join(projectRoot, 'Plugin', 'DynamicToolBridge');
  await fs.mkdir(privateConfigDir, { recursive: true });
  await fs.writeFile(path.join(privateConfigDir, 'config.env'), [
    'SmallModel_Enabled=true',
    'SmallModel_Use_Main_Config=false',
    'SmallModel_Endpoint=https://classifier.local/v1/chat/completions',
    'SmallModel_Model=tiny-classifier',
    'SmallModel_API_Key=private-test-key'
  ].join('\n'), 'utf8');

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                brief: 'Searches web references.',
                categories: ['search'],
                keywords: ['search'],
                confidence: 0.91
              })
            }
          }]
        };
      }
    };
  });

  const pluginManager = makePluginManager([
    makeManifest('PrivateSearch', 'Search the web with a private classifier.')
  ]);
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig()
  });

  await registry.syncFromPluginManager('private_small_model');
  await registry.flushClassificationQueue();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://classifier.local/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-test-key');

  const stateConfig = registry.getAdminState().config;
  assert.equal(stateConfig.smallModel.apiKey, undefined);
  assert.equal(stateConfig.smallModel.enabled, true);
  assert.equal(stateConfig.smallModel.endpoint, 'https://classifier.local/v1/chat/completions');

  const saved = await registry.updateConfig({ maxBriefListItems: 12 });
  assert.equal(saved.smallModel.apiKey, undefined);
  const configPath = path.join(projectRoot, 'ToolConfigs', 'dynamic_tool_bridge.config.json');
  const diskConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(diskConfig.smallModel.apiKey, undefined);
  assert.notEqual(diskConfig.smallModel.endpoint, 'https://classifier.local/v1/chat/completions');
  assert.notEqual(diskConfig.smallModel.model, 'tiny-classifier');
});

test('small model can reuse main upstream config with only model name', async (t) => {
  const projectRoot = await makeProjectRoot();
  const privateConfigDir = path.join(projectRoot, 'Plugin', 'DynamicToolBridge');
  await fs.mkdir(privateConfigDir, { recursive: true });
  await fs.writeFile(path.join(privateConfigDir, 'config.env'), [
    'SmallModel_Enabled=true',
    'SmallModel_Use_Main_Config=true',
    'SmallModel_Model=main-config-classifier'
  ].join('\n'), 'utf8');

  const oldApiUrl = process.env.API_URL;
  const oldApiKey = process.env.API_Key;
  process.env.API_URL = 'https://upstream.local';
  process.env.API_Key = 'main-upstream-key';
  t.after(() => {
    if (oldApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = oldApiUrl;
    if (oldApiKey === undefined) delete process.env.API_Key;
    else process.env.API_Key = oldApiKey;
  });

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options: { ...options, body: JSON.parse(options.body) } });
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                brief: 'Searches web references.',
                categories: ['search'],
                keywords: ['search'],
                confidence: 0.91
              })
            }
          }]
        };
      }
    };
  });

  const pluginManager = makePluginManager([
    makeManifest('MainConfigSearch', 'Search the web with the main upstream classifier.')
  ]);
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig()
  });

  await registry.syncFromPluginManager('main_config_small_model');
  await registry.flushClassificationQueue();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://upstream.local/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer main-upstream-key');
  assert.equal(requests[0].options.body.model, 'main-config-classifier');
});

test('small model classification asks for compact briefs and clamps verbose responses', async (t) => {
  const projectRoot = await makeProjectRoot();
  const privateConfigDir = path.join(projectRoot, 'Plugin', 'DynamicToolBridge');
  await fs.mkdir(privateConfigDir, { recursive: true });
  await fs.writeFile(path.join(privateConfigDir, 'config.env'), [
    'SmallModel_Enabled=true',
    'SmallModel_Use_Main_Config=true',
    'SmallModel_Model=compact-classifier'
  ].join('\n'), 'utf8');

  const oldApiUrl = process.env.API_URL;
  process.env.API_URL = 'https://upstream.local';
  t.after(() => {
    if (oldApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = oldApiUrl;
  });

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options: { ...options, body: JSON.parse(options.body) } });
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                brief: 'Searches web references with a very long explanation that should never be exposed in the lightweight tool list.',
                categories: ['search'],
                keywords: ['search'],
                confidence: 0.91
              })
            }
          }]
        };
      }
    };
  });

  const pluginManager = makePluginManager([
    makeManifest('CompactSearch', 'Search the web with the main upstream classifier.')
  ]);
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig()
  });

  await registry.syncFromPluginManager('compact_small_model');
  await registry.flushClassificationQueue();

  const prompt = requests[0].options.body.messages[1].content;
  assert.match(prompt, /15 tokens/);
  const record = registry.getAdminState().records[0];
  assert.equal(record.brief.includes('very long explanation'), false);
  assert.ok(record.brief.length <= 70, `brief should be compact, got ${record.brief.length} chars: ${record.brief}`);
});

test('small model uses independent OpenAI endpoint when main config reuse is disabled', async (t) => {
  const projectRoot = await makeProjectRoot();
  const privateConfigDir = path.join(projectRoot, 'Plugin', 'DynamicToolBridge');
  await fs.mkdir(privateConfigDir, { recursive: true });
  await fs.writeFile(path.join(privateConfigDir, 'config.env'), [
    'SmallModel_Enabled=true',
    'SmallModel_Use_Main_Config=false',
    'SmallModel_Endpoint=https://classifier.local',
    'SmallModel_Model=independent-classifier',
    'SmallModel_API_Key=independent-key'
  ].join('\n'), 'utf8');

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options: { ...options, body: JSON.parse(options.body) } });
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                brief: 'Searches web references.',
                categories: ['search'],
                keywords: ['search'],
                confidence: 0.91
              })
            }
          }]
        };
      }
    };
  });

  const pluginManager = makePluginManager([
    makeManifest('IndependentSearch', 'Search the web with an independent classifier.')
  ]);
  const registry = new DynamicToolRegistry();
  await registry.initialize({
    pluginManager,
    projectBasePath: projectRoot,
    config: testConfig()
  });

  await registry.syncFromPluginManager('independent_small_model');
  await registry.flushClassificationQueue();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://classifier.local/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer independent-key');
  assert.equal(requests[0].options.body.model, 'independent-classifier');
});
