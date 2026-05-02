const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const toolboxManager = require('../modules/toolboxManager.js');
const {
  ToolboxQueryError,
  queryStaticToolbox,
  resolveToolboxAlias,
  scoreBlock
} = require('../Plugin/StaticToolboxQuery/StaticToolboxQuery.js');

test.beforeEach(async () => {
  toolboxManager.setTvsDir(path.join(__dirname, '..', 'TVStxt'));
  await toolboxManager.loadMap();
});

test('resolves friendly aliases to registered static toolboxes', () => {
  assert.equal(resolveToolboxAlias('file'), 'VCPFileToolBox');
  assert.equal(resolveToolboxAlias('search'), 'VCPSearchToolBox');
  assert.equal(resolveToolboxAlias('flowlock'), 'VCPFlowLockToolBox');
  assert.equal(resolveToolboxAlias('VCPMemoToolBox'), 'VCPMemoToolBox');
});

test('list mode returns fold block directory without full block content', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'file',
    mode: 'list'
  });

  assert.equal(result.toolbox, 'VCPFileToolBox');
  assert.equal(result.mode, 'list');
  assert.ok(Array.isArray(result.availableBlocks));
  assert.ok(result.availableBlocks.length >= 2);
  assert.equal(Object.hasOwn(result.availableBlocks[0], 'content'), false);
  assert.ok(result.availableBlocks.every(block => typeof block.index === 'number'));
});

test('best mode returns relevant folded content for file write operations', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'VCPFileToolBox',
    query: 'WriteFile EditFile AppendFile 文件写入 编辑',
    mode: 'best',
    maxBlocks: 1
  });

  assert.equal(result.toolbox, 'VCPFileToolBox');
  assert.equal(result.mode, 'best');
  assert.equal(result.matchedBlocks.length, 1);
  assert.match(result.matchedBlocks[0].content, /WriteFile|EditFile|AppendFile/);
});

test('explicit block index can fetch a folded block content', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'file',
    mode: 'best',
    block: 2,
    maxBlocks: 1
  });

  assert.equal(result.matchedBlocks.length, 1);
  assert.equal(result.matchedBlocks[0].index, 2);
  assert.ok(result.matchedBlocks[0].content.length > 0);
});

test('all mode returns multiple non-base blocks within requested limit', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'search',
    mode: 'all',
    maxBlocks: 2
  });

  assert.equal(result.toolbox, 'VCPSearchToolBox');
  assert.equal(result.mode, 'all');
  assert.equal(result.matchedBlocks.length, 2);
  assert.ok(result.matchedBlocks.every(block => block.isBaseBlock === false));
});

test('best mode returns flowlock protocol content for continuation queries', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'flowlock',
    query: '续写 截断 暂停 恢复 status',
    mode: 'best',
    maxBlocks: 1
  });

  assert.equal(result.toolbox, 'VCPFlowLockToolBox');
  assert.equal(result.mode, 'best');
  assert.equal(result.matchedBlocks.length, 1);
  assert.match(result.matchedBlocks[0].content, /status|pause|resume|续写/);
});

test('best mode reports clear errors for unknown toolbox, invalid mode, and missing query', async () => {
  await assert.rejects(
    () => queryStaticToolbox({ toolbox: 'unknown', mode: 'list' }),
    error => error instanceof ToolboxQueryError && error.code === 'UNKNOWN_TOOLBOX'
  );

  await assert.rejects(
    () => queryStaticToolbox({ toolbox: 'file', mode: 'bad-mode' }),
    error => error instanceof ToolboxQueryError && error.code === 'INVALID_MODE'
  );

  await assert.rejects(
    () => queryStaticToolbox({ toolbox: 'file', mode: 'best', block: '2abc' }),
    error => error instanceof ToolboxQueryError && error.code === 'INVALID_BLOCK_INDEX'
  );

  await assert.rejects(
    () => queryStaticToolbox({ toolbox: 'file', mode: 'best' }),
    error => error instanceof ToolboxQueryError && error.code === 'QUERY_REQUIRED'
  );
});

test('maxChars truncates large matched content deterministically', async () => {
  const result = await queryStaticToolbox({
    toolbox: 'file',
    query: 'ServerFileOperator WriteFile EditFile',
    mode: 'best',
    maxBlocks: 1,
    maxChars: 500
  });

  assert.equal(result.truncated, true);
  assert.ok(result.matchedBlocks[0].content.length < 650);
});

test('scoring favors matching description, title, and content', () => {
  const score = scoreBlock(
    {
      description: '文件写入 编辑',
      content: '## 文件管理器完整能力\ncommand:「始」WriteFile「末」'
    },
    'WriteFile 文件写入',
    1
  );

  assert.ok(score > 0);
});

test('stdio invocation returns VCP-compatible JSON', () => {
  const pluginScript = path.join(__dirname, '..', 'Plugin', 'StaticToolboxQuery', 'StaticToolboxQuery.js');
  const child = spawnSync(process.execPath, [pluginScript], {
    cwd: path.join(__dirname, '..'),
    input: JSON.stringify({
      toolbox: 'file',
      query: 'WriteFile EditFile',
      mode: 'best',
      maxBlocks: 1
    }),
    encoding: 'utf8'
  });

  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.result.toolbox, 'VCPFileToolBox');
  assert.equal(parsed.result.matchedBlocks.length, 1);
});
