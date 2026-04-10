const assert = require('node:assert/strict');
const plugin = require('../Plugin/MemoInboxAPI/index.js');

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

async function main() {
  const router = createRouter();
  const runtimeContext = {
    memoDiaryName: 'MyMemos',
    imageServerKey: 'x',
  };
  const fakeStore = {
    async create(data) {
      return { memoId: 'memo_1', content: data.content, tags: data.tags || [] };
    },
    async getById(memoId) {
      if (memoId === 'missing') {
        throw new Error('MEMO_NOT_FOUND');
      }
      return { memoId, content: 'hello', tags: [] };
    },
    async update(memoId, patch) {
      return { memoId, content: patch.content || 'hello', tags: patch.tags || [] };
    },
    async softDelete() {},
    async restore(memoId) {
      return memoId;
    },
    async purge() {},
    async list() {
      return { items: [{ memoId: 'memo_1' }], nextCursor: null };
    },
    async listTrash() {
      return { items: [] };
    },
  };

  plugin.__setTestState({
    runtimeContext,
    memoStore: fakeStore,
    taskRegistry: { getSubscribers: () => new Set() },
    wss: null,
  });

  plugin.registerApiRoutes(router, {}, 'D:/vcp-hub/VCPToolBox', null);

  assert.equal(router.routes.length >= 8, true);

  const postRoute = router.routes.find((route) => route.method === 'POST' && route.path === '/memos');
  const getRoute = router.routes.find((route) => route.method === 'GET' && route.path === '/memos/:memoId');
  const patchRoute = router.routes.find((route) => route.method === 'PATCH' && route.path === '/memos/:memoId');
  const deleteRoute = router.routes.find((route) => route.method === 'DELETE' && route.path === '/memos/:memoId');

  const postRes = createResponse();
  await postRoute.handler({ body: { content: 'create body' } }, postRes);
  assert.equal(postRes.statusCode, 201);
  assert.equal(postRes.body.memoId, 'memo_1');

  const getRes = createResponse();
  await getRoute.handler({ params: { memoId: 'memo_1' } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.memoId, 'memo_1');

  const patchRes = createResponse();
  await patchRoute.handler({ params: { memoId: 'memo_1' }, body: { content: 'patched' } }, patchRes);
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.body.content, 'patched');

  const deleteRes = createResponse();
  await deleteRoute.handler({ params: { memoId: 'memo_1' } }, deleteRes);
  assert.equal(deleteRes.statusCode, 204);

  const notFoundRes = createResponse();
  await getRoute.handler({ params: { memoId: 'missing' } }, notFoundRes);
  assert.equal(notFoundRes.statusCode, 404);
  assert.equal(notFoundRes.body.error.code, 'MEMO_NOT_FOUND');

  console.log('memo-inbox-http-check:ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
