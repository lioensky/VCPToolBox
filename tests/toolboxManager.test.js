const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const messageProcessor = require('../modules/messageProcessor.js');
const toolboxManager = require('../modules/toolboxManager.js');
const tvsManager = require('../modules/tvsManager.js');

test('static TVStxt toolboxes are exposed as dynamic fold objects', async () => {
  toolboxManager.setTvsDir(path.join(__dirname, '..', 'TVStxt'));
  await toolboxManager.loadMap();

  const aliases = [
    'VCPFileToolBox',
    'VCPMemoToolBox',
    'VCPMediaToolBox',
    'VCPSearchToolBox',
    'VCPContactToolBox',
    'VCPFlowLockToolBox',
    'VCPObsidianToolBox'
  ];

  for (const alias of aliases) {
    assert.equal(toolboxManager.isToolbox(alias), true, `${alias} should be mapped`);

    const foldObj = await toolboxManager.getFoldObject(alias);
    assert.equal(foldObj.vcp_dynamic_fold, true, `${alias} should use vcp_dynamic_fold`);
    assert.equal(foldObj.dynamic_fold_strategy, 'toolbox_block_similarity');
    assert.ok(Array.isArray(foldObj.fold_blocks), `${alias} should expose fold blocks`);
    assert.ok(foldObj.fold_blocks.length >= 2, `${alias} should have folded sections`);
    assert.ok(foldObj.fold_blocks.every(block => typeof block.content === 'string'));
  }
});

test('Obsidian toolbox exposes focused folded protocol blocks', async () => {
  toolboxManager.setTvsDir(path.join(__dirname, '..', 'TVStxt'));
  await toolboxManager.loadMap();

  const foldObj = await toolboxManager.getFoldObject('VCPObsidianToolBox');
  const thresholds = foldObj.fold_blocks.map(block => block.threshold);

  assert.equal(foldObj.vcp_dynamic_fold, true);
  assert.ok(foldObj.fold_blocks.length >= 7);
  assert.ok(thresholds.includes(0.14));
  assert.ok(thresholds.includes(0.36));
  assert.ok(foldObj.fold_blocks.some(block => /ObsidianCoreGateway/.test(block.content)));
  assert.ok(foldObj.fold_blocks.some(block => /ObsidianVaultMemory/.test(block.content)));
});

test('message processor expands static toolbox placeholders through fold protocol', async () => {
  toolboxManager.setTvsDir(path.join(__dirname, '..', 'TVStxt'));
  await toolboxManager.loadMap();

  const pluginManager = {
    getAllPlaceholderValues: () => new Map(),
    getIndividualPluginDescriptions: () => new Map(),
    getResolvedPluginConfigValue: () => undefined,
    messagePreprocessors: new Map()
  };

  const output = await messageProcessor.replaceAgentVariables(
    '{{VCPFileToolBox}}',
    'test-model',
    'system',
    {
      pluginManager,
      detectors: [],
      superDetectors: [],
      cachedEmojiLists: {},
      expandedToolboxes: new Set(),
      messages: [{ role: 'user', content: '请读取一个文件' }],
      DEBUG_MODE: false
    }
  );

  assert.match(output, /VCP/);
  assert.equal(output.includes('{{VCPFileToolBox}}'), false);
  assert.equal(output.includes('[===vcp_fold'), false);
});

test('plain Var txt injection keeps fold markers as plain text', async () => {
  tvsManager.setTvsDir(path.join(__dirname, '..', 'TVStxt'));
  process.env.VarFlowLockPlainTest = 'flowlock.txt';

  const pluginManager = {
    getAllPlaceholderValues: () => new Map(),
    getIndividualPluginDescriptions: () => new Map(),
    getResolvedPluginConfigValue: () => undefined,
    messagePreprocessors: new Map()
  };

  const output = await messageProcessor.replaceOtherVariables(
    '{{VarFlowLockPlainTest}}',
    'test-model',
    'system',
    {
      pluginManager,
      detectors: [],
      superDetectors: [],
      cachedEmojiLists: {},
      expandedToolboxes: new Set(),
      messages: [{ role: 'user', content: '请继续续写' }],
      DEBUG_MODE: false
    }
  );

  delete process.env.VarFlowLockPlainTest;

  assert.match(output, /FlowLock/);
  assert.match(output, /\[===vcp_fold:0\.2/);
});
