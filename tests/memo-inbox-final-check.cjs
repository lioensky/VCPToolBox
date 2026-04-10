const assert = require('node:assert/strict');

async function main() {
  const reviewService = require('../Plugin/MemoInboxAPI/reviewService.js');
  const importService = require('../Plugin/MemoInboxAPI/importService.js');
  const maintenanceService = require('../Plugin/MemoInboxAPI/maintenanceService.js');
  const plugin = require('../Plugin/MemoInboxAPI/index.js');

  assert.equal(typeof reviewService.createReviewService, 'function');
  assert.equal(typeof importService.createImportService, 'function');
  assert.equal(typeof maintenanceService.createMaintenanceService, 'function');

  const memos = [
    {
      memoId: 'memo_a',
      content: '今天记录了搜索关键词 Alpha',
      tags: ['工作', 'Alpha'],
      createdAt: '2026-04-10T10:00:00.000Z',
      updatedAt: '2026-04-10T10:00:00.000Z',
      deleted: false,
      attachments: [],
      meta: { memoId: 'memo_a', source: 'api' },
      header: { date: '2026-04-10', maidName: 'MemoInbox' },
      filename: '2026-04-10-10_00_00-memo_a.txt',
    },
    {
      memoId: 'memo_b',
      content: '复盘 Beta 任务并记录经验',
      tags: ['复盘', 'Beta'],
      createdAt: '2026-04-09T09:00:00.000Z',
      updatedAt: '2026-04-09T09:00:00.000Z',
      deleted: false,
      attachments: [],
      meta: { memoId: 'memo_b', source: 'api' },
      header: { date: '2026-04-09', maidName: 'MemoInbox' },
      filename: '2026-04-09-09_00_00-memo_b.txt',
    },
  ];

  const taskEvents = [];
  const taskState = new Map();
  const createdImports = [];

  const taskRegistry = {
    createTask(task) {
      const value = {
        ...task,
        status: task.status || 'accepted',
        progress: task.progress || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      taskState.set(task.taskId, value);
      return value;
    },
    updateTask(taskId, patch) {
      const current = taskState.get(taskId);
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      taskState.set(taskId, next);
      taskEvents.push(next);
      return next;
    },
    getTask(taskId) {
      return taskState.get(taskId) || null;
    },
    listTasks() {
      return Array.from(taskState.values());
    },
  };

  const memoStore = {
    async list() {
      return { items: memos.filter((memo) => !memo.deleted), nextCursor: null };
    },
    async listTrash() {
      return { items: memos.filter((memo) => memo.deleted) };
    },
    async create(item) {
      const created = {
        memoId: `memo_import_${createdImports.length + 1}`,
        content: item.content,
        tags: item.tags || [],
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.createdAt || new Date().toISOString(),
        deleted: false,
        attachments: [],
        meta: { memoId: `memo_import_${createdImports.length + 1}`, source: 'import' },
        header: { date: '2026-04-10', maidName: 'MemoInbox' },
        filename: `2026-04-10-10_00_0${createdImports.length + 1}-memo_import_${createdImports.length + 1}.txt`,
      };
      createdImports.push(created);
      memos.push(created);
      return created;
    },
    async rebuildIndex() {
      return undefined;
    },
  };

  const review = reviewService.createReviewService({ memoStore });
  const searchResult = await review.search({
    q: 'Alpha',
    tag: null,
    from: null,
    to: null,
    limit: 10,
  });
  assert.equal(searchResult.items.length, 1);
  assert.equal(searchResult.items[0].memoId, 'memo_a');

  const randomReview = await review.random();
  assert.equal(Boolean(randomReview.memoId), true);

  const dailyReview = await review.daily();
  assert.equal(Boolean(dailyReview.memoId), true);
  assert.equal(typeof dailyReview.reviewReason, 'string');

  const importer = importService.createImportService({
    memoStore,
    taskRegistry,
    concurrency: 1,
  });
  const accepted = await importer.startImport({
    items: [{ content: '导入一条', tags: ['导入'] }],
    mode: 'insert',
  });
  assert.equal(accepted.status, 'accepted');
  await accepted.done;
  assert.equal(taskRegistry.getTask(accepted.taskId).status, 'completed');
  assert.equal(createdImports.length, 1);

  const maintenance = maintenanceService.createMaintenanceService({
    memoStore,
    taskRegistry,
    runtimeContext: {
      memoRootPath: 'D:/tmp/memos',
      memoTrashPath: 'D:/tmp/memos/.trash',
      memoImageRootPath: 'D:/tmp/image/memo-inbox',
    },
  });
  const status = await maintenance.getStatus();
  assert.equal(status.memoCount >= 2, true);
  assert.equal(typeof status.taskSummary.total, 'number');

  const router = createRouter();
  plugin.__setTestState({
    runtimeContext: {
      memoDiaryName: 'MyMemos',
      imageServerKey: 'x',
      memoRootPath: 'D:/tmp/memos',
      memoTrashPath: 'D:/tmp/memos/.trash',
      memoImageRootPath: 'D:/tmp/image/memo-inbox',
    },
    memoStore,
    taskRegistry,
    reviewService: review,
    importService: importer,
    maintenanceService: maintenance,
    wss: null,
    wsCleanup: null,
  });
  plugin.registerApiRoutes(router, {}, 'D:/vcp-hub/VCPToolBox', null);

  const searchRoute = router.routes.find((route) => route.method === 'GET' && route.path === '/search');
  const importRoute = router.routes.find((route) => route.method === 'POST' && route.path === '/imports');
  const taskRoute = router.routes.find((route) => route.method === 'GET' && route.path === '/tasks/:taskId');
  const maintenanceStatusRoute = router.routes.find(
    (route) => route.method === 'GET' && route.path === '/maintenance/status',
  );

  const searchRes = createResponse();
  await searchRoute.handler({ query: { q: 'Beta', limit: '10' } }, searchRes);
  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.body.items.length, 1);

  const importRes = createResponse();
  await importRoute.handler(
    { body: { items: [{ content: '再导入一条', tags: ['导入'] }], mode: 'insert' } },
    importRes,
  );
  assert.equal(importRes.statusCode, 202);
  assert.equal(importRes.body.status, 'accepted');

  const taskRes = createResponse();
  await taskRoute.handler({ params: { taskId: importRes.body.taskId } }, taskRes);
  assert.equal(taskRes.statusCode, 200);
  assert.equal(taskRes.body.taskId, importRes.body.taskId);

  const maintenanceRes = createResponse();
  await maintenanceStatusRoute.handler({}, maintenanceRes);
  assert.equal(maintenanceRes.statusCode, 200);
  assert.equal(typeof maintenanceRes.body.memoCount, 'number');

  console.log('memo-inbox-final-check:ok');
}

function createRouter() {
  const routes = [];
  return {
    routes,
    get(path, handler) {
      routes.push({ method: 'GET', path, handler });
    },
    post(path, handler) {
      routes.push({ method: 'POST', path, handler });
    },
    patch(path, handler) {
      routes.push({ method: 'PATCH', path, handler });
    },
    delete(path, handler) {
      routes.push({ method: 'DELETE', path, handler });
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
