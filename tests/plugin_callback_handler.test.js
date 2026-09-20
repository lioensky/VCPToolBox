const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginCallbackHandler } = require('../modules/handlers/pluginCallbackHandler');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function makeRuntime(t, overrides = {}) {
  const asyncResultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-callback-handler-'));
  t.after(() => fs.rm(asyncResultsDir, { recursive: true, force: true }));

  const completionEvents = [];
  const webSocketEvents = [];
  const pluginManager = overrides.pluginManager || {
    getPlugin() {
      return {
        webSocketPush: {
          enabled: true,
          targetClientType: 'LegacyClient',
          messageType: 'legacy_callback'
        }
      };
    },
    emitAsyncTaskCompleted(pluginName, taskId) {
      completionEvents.push({ pluginName, taskId });
      return true;
    }
  };
  const webSocketServer = overrides.webSocketServer || {
    broadcast(message, targetClientType) {
      webSocketEvents.push({ message, targetClientType });
    }
  };

  return {
    asyncResultsDir,
    completionEvents,
    webSocketEvents,
    handler: createPluginCallbackHandler({
      asyncResultsDir,
      fsPromises: overrides.fsPromises || fs,
      pluginManager,
      webSocketServer,
      logger: overrides.logger || { error() {}, log() {} },
      debugMode: false
    })
  };
}

async function invoke(handler, body = {}) {
  const req = {
    params: { pluginName: 'RoutePlugin', taskId: 'route-task-123' },
    body
  };
  const res = makeResponse();
  await handler(req, res);
  return res;
}

test('successful callback persists body and emits only validated route identifiers', async (t) => {
  const runtime = await makeRuntime(t);
  const callbackBody = {
    pluginName: 'ForgedBodyPlugin',
    taskId: 'forged-body-task',
    parentRequestId: 'forged-parent',
    result: 'completed'
  };

  const res = await invoke(runtime.handler, callbackBody);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'success');
  assert.deepEqual(runtime.completionEvents, [{
    pluginName: 'RoutePlugin',
    taskId: 'route-task-123'
  }]);
  assert.equal(runtime.webSocketEvents.length, 1);
  const persisted = JSON.parse(await fs.readFile(
    path.join(runtime.asyncResultsDir, 'RoutePlugin-route-task-123.json'),
    'utf8'
  ));
  assert.deepEqual(persisted, callbackBody);
});
test('callback rejects colon identifiers before attempting persistence', async (t) => {
  const runtime = await makeRuntime(t);
  const req = {
    params: { pluginName: 'RoutePlugin:unsafe', taskId: 'route-task-123' },
    body: { result: 'must-not-persist' }
  };
  const res = makeResponse();

  await runtime.handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.status, 'error');
  assert.deepEqual(runtime.completionEvents, []);
  assert.deepEqual(runtime.webSocketEvents, []);
  const files = await fs.readdir(runtime.asyncResultsDir);
  assert.deepEqual(files, []);
});

test('persistence failure returns failure and emits no notifications', async (t) => {
  const writes = [];
  const runtime = await makeRuntime(t, {
    fsPromises: {
      async mkdir() {},
      async writeFile(...args) {
        writes.push(args);
        throw new Error('simulated write failure');
      }
    }
  });

  const res = await invoke(runtime.handler, { result: 'not-persisted' });

  assert.equal(writes.length, 1);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.status, 'error');
  assert.deepEqual(runtime.completionEvents, []);
  assert.deepEqual(runtime.webSocketEvents, []);
});

test('legacy WebSocket failure does not change a successfully persisted response', async (t) => {
  const runtime = await makeRuntime(t, {
    webSocketServer: {
      broadcast() {
        throw new Error('legacy broadcast failure');
      }
    }
  });

  const res = await invoke(runtime.handler, { result: 'persisted' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'success');
  assert.deepEqual(runtime.completionEvents, [{
    pluginName: 'RoutePlugin',
    taskId: 'route-task-123'
  }]);
});

test('integration notification failure does not change a successfully persisted response', async (t) => {
  const webSocketEvents = [];
  const runtime = await makeRuntime(t, {
    pluginManager: {
      getPlugin() {
        return { webSocketPush: { enabled: true } };
      },
      emitAsyncTaskCompleted() {
        throw new TypeError('integration notification failure');
      }
    },
    webSocketServer: {
      broadcast(message, targetClientType) {
        webSocketEvents.push({ message, targetClientType });
      }
    }
  });

  const res = await invoke(runtime.handler, { result: 'persisted' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(webSocketEvents.length, 1);
});

test('duplicate persisted callbacks emit completion each time for downstream ledger deduplication', async (t) => {
  const runtime = await makeRuntime(t);

  const first = await invoke(runtime.handler, { attempt: 1 });
  const second = await invoke(runtime.handler, { attempt: 2 });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(runtime.completionEvents, [
    { pluginName: 'RoutePlugin', taskId: 'route-task-123' },
    { pluginName: 'RoutePlugin', taskId: 'route-task-123' }
  ]);
  const persisted = JSON.parse(await fs.readFile(
    path.join(runtime.asyncResultsDir, 'RoutePlugin-route-task-123.json'),
    'utf8'
  ));
  assert.deepEqual(persisted, { attempt: 2 });
});
