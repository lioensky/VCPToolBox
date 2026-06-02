const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const express = require('express');

const dailyNotePanel = require('../Plugin/DailyNotePanel');

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function makeProjectWithDailyNoteRoute() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dailynote-panel-route-'));
  const routesDir = path.join(projectRoot, 'routes');
  await fs.mkdir(routesDir, { recursive: true });
  await fs.writeFile(
    path.join(routesDir, 'dailyNotesRoutes.js'),
    [
      'module.exports = function createDailyNotesRoutes() {',
      '  return function dailyNotesRoutes(req, res, next) {',
      "    if (req.path === '/ping') {",
      '      res.json({ ok: true, adminAuthSeen: req.adminAuthSeen === true });',
      '      return;',
      '    }',
      '    next();',
      '  };',
      '};',
      '',
    ].join('\n'),
    'utf8'
  );
  return projectRoot;
}

test('DailyNotePanel routes are hoisted before AdminPanel catch-all while preserving adminAuth', async (t) => {
  const projectRoot = await makeProjectWithDailyNoteRoute();
  t.after(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const app = express();
  function adminAuth(req, res, next) {
    if (req.path.startsWith('/AdminPanel')) {
      req.adminAuthSeen = true;
    }
    next();
  }

  app.use(adminAuth);
  app.use('/AdminPanel', (req, res) => {
    res.status(418).send('AdminPanel catch-all');
  });

  dailyNotePanel.registerRoutes(
    app,
    express.Router(),
    {
      DebugMode: false,
      PanelPathPrefix: '/AdminPanel/DailyNotePanel',
      ApiPathPrefix: '/AdminPanel/dailynote_api',
    },
    projectRoot
  );

  await withServer(app, async (baseUrl) => {
    const apiResponse = await fetch(`${baseUrl}/AdminPanel/dailynote_api/ping`);
    assert.equal(apiResponse.status, 200);
    assert.deepEqual(await apiResponse.json(), { ok: true, adminAuthSeen: true });

    const staticResponse = await fetch(`${baseUrl}/AdminPanel/DailyNotePanel/sw.js`);
    assert.equal(staticResponse.status, 200);
    assert.match(await staticResponse.text(), /PROTECTED_API_PREFIXES/);

    const catchAllResponse = await fetch(`${baseUrl}/AdminPanel/other`);
    assert.equal(catchAllResponse.status, 418);
  });
});

function loadServiceWorker() {
  const listeners = new Map();
  const fetchCalls = [];
  const cachedResponses = new Map();

  const cacheStore = {
    addAll() {
      return Promise.resolve();
    },
    put(request, response) {
      cachedResponses.set(request.url, response);
      return Promise.resolve();
    },
  };

  const context = {
    URL,
    Headers,
    Request,
    Response,
    Promise,
    console,
    fetch(request) {
      fetchCalls.push(request);
      return Promise.resolve(new Response('network-ok', { status: 200 }));
    },
    caches: {
      open() {
        return Promise.resolve(cacheStore);
      },
      keys() {
        return Promise.resolve([]);
      },
      delete() {
        return Promise.resolve(true);
      },
      match(request) {
        return Promise.resolve(cachedResponses.get(request.url));
      },
    },
    self: {
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      skipWaiting() {
        return Promise.resolve();
      },
      clients: {
        claim() {
          return Promise.resolve();
        },
      },
    },
  };

  const source = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'Plugin', 'DailyNotePanel', 'frontend', 'sw.js'),
    'utf8'
  );
  vm.runInNewContext(source, context, { filename: 'sw.js' });

  async function dispatchFetch(request) {
    let responsePromise = null;
    listeners.get('fetch')({
      request,
      respondWith(promise) {
        responsePromise = Promise.resolve(promise);
      },
    });
    return responsePromise;
  }

  return { dispatchFetch, fetchCalls };
}

test('DailyNotePanel service worker forwards protected API requests to adminAuth without caching', async () => {
  const sw = loadServiceWorker();
  const response = await sw.dispatchFetch(new Request('https://vcp.local/AdminPanel/dailynote_api/notebooks'));

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'network-ok');
  assert.equal(sw.fetchCalls.length, 1);
  assert.equal(sw.fetchCalls[0].url, 'https://vcp.local/AdminPanel/dailynote_api/notebooks');
});

test('DailyNotePanel service worker forwards protected API requests with Authorization', async () => {
  const sw = loadServiceWorker();
  const request = new Request('https://vcp.local/AdminPanel/dailynote_api/notebooks', {
    headers: { Authorization: 'Basic test-token' },
  });
  const response = await sw.dispatchFetch(request);

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'network-ok');
  assert.equal(sw.fetchCalls.length, 1);
  assert.equal(sw.fetchCalls[0], request);
});

test('DailyNotePanel service worker does not cache its own service worker script', async () => {
  const sw = loadServiceWorker();
  const response = await sw.dispatchFetch(new Request('https://vcp.local/AdminPanel/DailyNotePanel/sw.js'));

  assert.equal(response, null);
  assert.equal(sw.fetchCalls.length, 0);
});
