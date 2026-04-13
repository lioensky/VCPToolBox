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

test('MemoInboxAPI PATCH /memos/:memoId 支持 multipart 附件变更并透传最终附件语义', async () => {
  const plugin = require(pluginModulePath);

  function createRouter() {
    const routes = [];
    return {
      routes,
      get(routePath, handler) {
        routes.push({ method: 'GET', path: routePath, handler });
      },
      post(routePath, handler) {
        routes.push({ method: 'POST', path: routePath, handler });
      },
      patch(routePath, handler) {
        routes.push({ method: 'PATCH', path: routePath, handler });
      },
      delete(routePath, handler) {
        routes.push({ method: 'DELETE', path: routePath, handler });
      },
    };
  }

  function createResponse() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  const router = createRouter();
  const updateCalls = [];
  const fakeStore = {
    async update(memoId, patch) {
      updateCalls.push({ memoId, patch });
      return {
        memoId,
        content: patch.content ?? 'updated',
        tags: patch.tags ?? [],
        attachments: [
          ...(patch.keepAttachmentUrls || []),
          ...((patch.newAttachments || []).map((attachment) => attachment.url))
        ],
      };
    },
  };

  plugin.__setTestState({
    runtimeContext: {
      memoDiaryName: 'MyMemos',
      memoImageSubdir: 'memo-inbox',
      memoImageRootPath: 'D:/tmp/image/memo-inbox',
      imageServerKey: 'image-key',
    },
    memoStore: fakeStore,
    taskRegistry: { getSubscribers: () => new Set() },
    wss: null,
    memoUploadMiddleware: (req, _res, next) => {
      req.body = {
        content: '更新后的 memo',
        tags: '["工作"]',
        keepAttachmentUrls: '["/images/memo-inbox/2026/04/12/keep.png"]',
      };
      req.files = [
        {
          buffer: Buffer.from('new image'),
          mimetype: 'image/png',
        },
      ];
      next();
    },
  });

  plugin.registerApiRoutes(router, {}, 'D:/vcp-hub/VCPToolBox', null);
  const patchRoute = router.routes.find((route) => route.method === 'PATCH' && route.path === '/memos/:memoId');
  const response = createResponse();

  await patchRoute.handler(
    {
      params: { memoId: 'memo_1' },
      headers: { 'content-type': 'multipart/form-data; boundary=test' },
      body: {},
      files: [],
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(updateCalls.length, 1);
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const attachmentDatePath = `${year}/${month}/${day}`;
  assert.deepEqual(updateCalls[0], {
    memoId: 'memo_1',
    patch: {
      content: '更新后的 memo',
      tags: ['工作'],
      keepAttachmentUrls: ['/images/memo-inbox/2026/04/12/keep.png'],
      newAttachments: [
        {
          imageId: 'memo_1-1',
          url: `/pw=image-key/images/memo-inbox/${attachmentDatePath}/memo_1-1.png`,
          mimeType: 'image/png',
          relativePath: `memo-inbox/${attachmentDatePath}/memo_1-1.png`,
        },
      ],
    },
  });
});

test('memoStore.update 根据 keepAttachmentUrls 和 newAttachments 生成最终附件并清理移除的本地图片', async () => {
  const memoFormat = require('../Plugin/MemoInboxAPI/memoFormat.js');
  const { createMemoStore } = require('../Plugin/MemoInboxAPI/memoStore.js');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memo-inbox-update-'));

  try {
    const runtimeContext = {
      projectBasePath: tempRoot,
      memoDiaryName: 'MyMemos',
      memoMaidName: 'MemoInbox',
      memoRootPath: path.join(tempRoot, 'dailynote', 'MyMemos'),
      memoTrashPath: path.join(tempRoot, 'dailynote', 'MyMemos', '.trash'),
      memoImageRootPath: path.join(tempRoot, 'image', 'memo-inbox'),
      imageServerKey: 'image-key',
      pluginManager: {
        async processToolCall() {
          throw new Error('not used');
        },
      },
    };

    await fs.mkdir(runtimeContext.memoRootPath, { recursive: true });
    await fs.mkdir(runtimeContext.memoTrashPath, { recursive: true });
    await fs.mkdir(path.join(runtimeContext.memoImageRootPath, '2026', '04', '12'), { recursive: true });

    const removedImagePath = path.join(runtimeContext.memoImageRootPath, '2026', '04', '12', 'remove.png');
    const keptImagePath = path.join(runtimeContext.memoImageRootPath, '2026', '04', '12', 'keep.png');
    await fs.writeFile(removedImagePath, 'remove-me', 'utf8');
    await fs.writeFile(keptImagePath, 'keep-me', 'utf8');

    const memoFilePath = path.join(runtimeContext.memoRootPath, '2026-04-12-10_00_00-memo_1.txt');
    await fs.writeFile(
      memoFilePath,
      [
        '[2026-04-12] - MemoInbox',
        '原始正文',
        'Attachments: /images/memo-inbox/2026/04/12/remove.png, /images/memo-inbox/2026/04/12/keep.png, https://example.com/external.png',
        'Meta: memoId=memo_1, source=api',
        'Tag: 工作',
      ].join('\n'),
      'utf8',
    );

    const memoStore = createMemoStore({
      runtimeContext,
      memoFormat,
    });

    const updated = await memoStore.update('memo_1', {
      keepAttachmentUrls: [
        '/images/memo-inbox/2026/04/12/keep.png',
        'https://example.com/external.png',
      ],
      newAttachments: [
        {
          imageId: 'memo_1-3',
          url: '/images/memo-inbox/2026/04/12/new.png',
          mimeType: 'image/png',
          relativePath: 'memo-inbox/2026/04/12/new.png',
        },
      ],
    });

    assert.deepEqual(updated.attachments, [
      '/images/memo-inbox/2026/04/12/keep.png',
      'https://example.com/external.png',
      '/images/memo-inbox/2026/04/12/new.png',
    ]);

    await assert.rejects(() => fs.stat(removedImagePath), { code: 'ENOENT' });
    const keptStat = await fs.stat(keptImagePath);
    assert.equal(keptStat.isFile(), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
