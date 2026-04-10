const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pluginModulePath = path.join(__dirname, '..', 'Plugin', 'MemoInboxAPI', 'index.js');
const runtimeModulePath = path.join(__dirname, '..', 'Plugin', 'MemoInboxAPI', 'runtime.js');

test('MemoInboxAPI 插件模块导出 hybridservice 生命周期接口', async () => {
  const plugin = require(pluginModulePath);

  assert.equal(typeof plugin.initialize, 'function');
  assert.equal(typeof plugin.registerApiRoutes, 'function');
  assert.equal(typeof plugin.processToolCall, 'function');
  assert.equal(typeof plugin.shutdown, 'function');
});

test('MemoInboxAPI runtime 可构建上下文并创建所需目录', async () => {
  const { buildRuntimeContext, ensureRuntimeDirectories } = require(runtimeModulePath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-inbox-runtime-'));
  const projectBasePath = path.join(tempRoot, 'project');

  await fs.mkdir(projectBasePath, { recursive: true });

  const originalKnowledgeBaseRoot = process.env.KNOWLEDGEBASE_ROOT_PATH;
  const originalImageKey = process.env.IMAGESERVER_IMAGE_KEY;

  process.env.KNOWLEDGEBASE_ROOT_PATH = path.join(tempRoot, 'kb-root');
  process.env.IMAGESERVER_IMAGE_KEY = 'image-key-for-test';

  try {
    const runtimeContext = buildRuntimeContext({
      config: {
        MemoDiaryName: 'MyMemos',
        MemoImageSubdir: 'memo-inbox',
        MemoMaidName: 'MemoInbox',
      },
      projectBasePath,
    });

    assert.equal(runtimeContext.projectBasePath, projectBasePath);
    assert.equal(runtimeContext.memoDiaryName, 'MyMemos');
    assert.equal(runtimeContext.memoMaidName, 'MemoInbox');
    assert.equal(runtimeContext.imageServerKey, 'image-key-for-test');
    assert.equal(
      runtimeContext.memoRootPath,
      path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'MyMemos'),
    );
    assert.equal(
      runtimeContext.memoTrashPath,
      path.join(process.env.KNOWLEDGEBASE_ROOT_PATH, 'MyMemos', '.trash'),
    );
    assert.equal(
      runtimeContext.memoImageRootPath,
      path.join(projectBasePath, 'image', 'memo-inbox'),
    );

    await ensureRuntimeDirectories(runtimeContext);

    const memoRootStat = await fs.stat(runtimeContext.memoRootPath);
    const memoTrashStat = await fs.stat(runtimeContext.memoTrashPath);
    const memoImageStat = await fs.stat(runtimeContext.memoImageRootPath);

    assert.equal(memoRootStat.isDirectory(), true);
    assert.equal(memoTrashStat.isDirectory(), true);
    assert.equal(memoImageStat.isDirectory(), true);
  } finally {
    if (originalKnowledgeBaseRoot === undefined) {
      delete process.env.KNOWLEDGEBASE_ROOT_PATH;
    } else {
      process.env.KNOWLEDGEBASE_ROOT_PATH = originalKnowledgeBaseRoot;
    }

    if (originalImageKey === undefined) {
      delete process.env.IMAGESERVER_IMAGE_KEY;
    } else {
      process.env.IMAGESERVER_IMAGE_KEY = originalImageKey;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
