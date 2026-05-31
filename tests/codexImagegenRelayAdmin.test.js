const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const createCodexImagegenRelayAdminRoute = require('../routes/admin/codexImagegenRelay');
const { PROTOCOL, FIXED_ASSET_RETURN_DIR } = require('../modules/codexImagegenRelayQueue');

async function withRelayApp(t, callback) {
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-imagegen-admin-'));
  t.after(async () => {
    await fs.rm(queueRoot, { recursive: true, force: true });
  });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.adminAuthUser = 'admin-root';
    next();
  });
  app.use(createCodexImagegenRelayAdminRoute({
    codexImagegenRelayQueueRoot: queueRoot,
  }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback(baseUrl, queueRoot);
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

async function writeStatusFile(queueRoot, status, requestId, payload) {
  const dirPath = path.join(queueRoot, status);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(
    path.join(dirPath, `${requestId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8'
  );
}

test('codex imagegen admin route creates, lists, reads, and cancels requests', async (t) => {
  await withRelayApp(t, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/codex-imagegen/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'img_route_001',
        prompt: 'A studio product image',
        options: { quality: 'high' },
      }),
    });
    assert.equal(createResponse.status, 201);
    const createBody = await createResponse.json();
    assert.equal(createBody.success, true);
    assert.equal(createBody.request.status, 'pending');

    const listResponse = await fetch(`${baseUrl}/codex-imagegen/requests?status=pending`);
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.success, true);
    assert.equal(listBody.requests.length, 1);
    assert.equal(listBody.requests[0].request_id, 'img_route_001');

    const getResponse = await fetch(`${baseUrl}/codex-imagegen/requests/img_route_001`);
    assert.equal(getResponse.status, 200);
    const getBody = await getResponse.json();
    assert.equal(getBody.request.prompt, 'A studio product image');

    const cancelResponse = await fetch(`${baseUrl}/codex-imagegen/requests/img_route_001/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not needed' }),
    });
    assert.equal(cancelResponse.status, 200);
    const cancelBody = await cancelResponse.json();
    assert.equal(cancelBody.request.status, 'cancelled');
    assert.equal(cancelBody.request.cancelled_by, 'admin-root');
  });
});

test('codex imagegen admin route returns structured validation errors', async (t) => {
  await withRelayApp(t, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/codex-imagegen/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'img_route_secret',
        prompt: 'secret reject',
        authorization: 'Bearer no',
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'secret_like_field_rejected');
  });
});

test('codex imagegen admin route retries failed and marks artifact files saved', async (t) => {
  await withRelayApp(t, async (baseUrl, queueRoot) => {
    await writeStatusFile(queueRoot, 'failed', 'img_route_failed', {
      protocol: PROTOCOL,
      request_id: 'img_route_failed',
      created_at: '2026-05-31T09:00:00.000Z',
      status: 'failed',
      mode: 'generate',
      prompt: 'retry route',
      attempt: 0,
      idempotency_key: 'idem_route_failed',
    });

    const retryResponse = await fetch(`${baseUrl}/codex-imagegen/requests/img_route_failed/retry`, {
      method: 'POST',
    });
    assert.equal(retryResponse.status, 201);
    const retryBody = await retryResponse.json();
    assert.equal(retryBody.request.status, 'pending');
    assert.equal(retryBody.request.parent_request_id, 'img_route_failed');

    await writeStatusFile(queueRoot, 'artifact_ready', 'img_route_ready', {
      protocol: PROTOCOL,
      request_id: 'img_route_ready',
      created_at: '2026-05-31T09:00:00.000Z',
      status: 'artifact_ready',
      mode: 'generate',
      prompt: 'mark saved route',
      attempt: 1,
      idempotency_key: 'idem_route_ready',
      result: {
        generated_by: 'codex_builtin_image_gen',
        local_files: [],
        manual_save_required: true,
      },
    });
    await fs.writeFile(path.join(queueRoot, 'assets', 'img_route_ready.png'), 'png', 'utf8');

    const savedResponse = await fetch(`${baseUrl}/codex-imagegen/requests/img_route_ready/mark-saved`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        local_files: [`${FIXED_ASSET_RETURN_DIR}/img_route_ready.png`],
      }),
    });
    assert.equal(savedResponse.status, 200);
    const savedBody = await savedResponse.json();
    assert.equal(savedBody.request.status, 'done');
    assert.deepEqual(savedBody.request.result.local_files, [
      `${FIXED_ASSET_RETURN_DIR}/img_route_ready.png`,
    ]);
  });
});

test('codex imagegen admin route rejects unsafe mark-saved paths', async (t) => {
  await withRelayApp(t, async (baseUrl, queueRoot) => {
    await writeStatusFile(queueRoot, 'artifact_ready', 'img_route_unsafe', {
      protocol: PROTOCOL,
      request_id: 'img_route_unsafe',
      created_at: '2026-05-31T09:00:00.000Z',
      status: 'artifact_ready',
      mode: 'generate',
      prompt: 'unsafe path',
      attempt: 1,
      idempotency_key: 'idem_route_unsafe',
    });

    const response = await fetch(`${baseUrl}/codex-imagegen/requests/img_route_unsafe/mark-saved`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_files: ['../outside.png'] }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'unsafe_asset_path');
  });
});

test('independent admin server registers codex imagegen relay as a local module', async () => {
  const adminServerSource = await fs.readFile(
    path.join(__dirname, '..', 'adminServer.js'),
    'utf8'
  );
  const localModulesMatch = adminServerSource.match(/const localModules = \[([\s\S]*?)\];/);

  assert.ok(localModulesMatch, 'adminServer.js must define localModules');
  assert.match(localModulesMatch[1], /['"]codexImagegenRelay['"]/);
});
