const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.env');
const SERVER_URL = 'http://127.0.0.1:6005';
const API_BASE = `${SERVER_URL}/api/plugins/MemoInboxAPI`;
const LOG_OUT = path.join(ROOT, 'memo-inbox-real-e2e.out.log');
const LOG_ERR = path.join(ROOT, 'memo-inbox-real-e2e.err.log');
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=';

async function main() {
  const envMap = readEnvFile(CONFIG_PATH);
  const key = envMap.Key;
  const vcpKey = envMap.VCP_Key;

  assert.ok(key, 'config.env 缺少 Key');
  assert.ok(vcpKey, 'config.env 缺少 VCP_Key');

  cleanupLog(LOG_OUT);
  cleanupLog(LOG_ERR);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  server.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
    fs.appendFileSync(LOG_OUT, chunk);
  });
  server.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
    fs.appendFileSync(LOG_ERR, chunk);
  });

  try {
    const status = await waitForStatus(key);
    assert.equal(status.status, 'ok');
    assert.equal(status.plugin, 'MemoInboxAPI');
    assert.equal(status.imageServerKeyConfigured, true);

    const created = await requestJson(key, '/memos', {
      method: 'POST',
      body: {
        content: '真实测试 memo 一\nTag 触发 #memo-inbox',
        tags: ['memo-inbox', 'real-http'],
        source: 'http-test',
      },
      expectedStatus: 201,
    });
    assert.match(created.memoId, /^memo_/);
    assert.deepEqual(created.tags, ['memo-inbox', 'real-http']);

    const fetched = await requestJson(key, `/memos/${created.memoId}`);
    assert.equal(fetched.memoId, created.memoId);
    assert.match(fetched.content, /真实测试 memo 一/);

    const updated = await requestJson(key, `/memos/${created.memoId}`, {
      method: 'PATCH',
      body: {
        content: '真实测试 memo 一 已更新',
        tags: ['memo-inbox', 'updated'],
      },
    });
    assert.equal(updated.content, '真实测试 memo 一 已更新');
    assert.deepEqual(updated.tags, ['memo-inbox', 'updated']);

    const list = await requestJson(key, '/memos?limit=10');
    assert.ok(Array.isArray(list.items));
    assert.ok(list.items.some((item) => item.memoId === created.memoId));

    const search = await requestJson(key, '/search?q=' + encodeURIComponent('真实测试') + '&limit=10');
    assert.ok(search.items.some((item) => item.memoId === created.memoId));

    const multipart = await createMultipartMemo(key);
    assert.match(multipart.memoId, /^memo_/);
    assert.equal(multipart.attachments.length, 1);
    assert.match(multipart.attachments[0], /^\/pw=.*\/images\/memo-inbox\//);

    const maintenance = await requestJson(key, '/maintenance/status');
    assert.ok(maintenance.memoCount >= 2);
    assert.ok(maintenance.paths.memoRootPath.endsWith(path.join('dailynote', 'MyMemos')));

    const wsMessages = [];
    const ws = await connectMemoWs(vcpKey, wsMessages);

    const importAccepted = await requestJson(key, '/imports', {
      method: 'POST',
      body: {
        items: [
          { content: '导入项 A #import-a', tags: ['import-a'] },
          { content: '导入项 B #import-b', tags: ['import-b'] },
        ],
        mode: 'insert',
      },
      expectedStatus: 202,
    });
    assert.match(importAccepted.taskId, /^memo-task-/);

    ws.send(
      JSON.stringify({
        type: 'memo_subscribe_task',
        data: { taskId: importAccepted.taskId },
      }),
    );

    const task = await waitForTask(key, importAccepted.taskId);
    assert.equal(task.status, 'completed');
    assert.equal(task.result.imported, 2);
    assert.equal(task.result.failed, 0);

    await waitForWsEvent(wsMessages, (message) => {
      return (
        message.type === 'memo_task_completed' &&
        message.data &&
        message.data.taskId === importAccepted.taskId
      );
    });

    const taskErrors = await requestJson(key, `/tasks/${importAccepted.taskId}/errors`);
    assert.deepEqual(taskErrors.errors, []);

    await request(key, `/memos/${created.memoId}`, { method: 'DELETE', expectedStatus: 204 });
    const trash = await requestJson(key, '/trash');
    assert.ok(trash.items.some((item) => item.memoId === created.memoId));

    const restored = await requestJson(key, `/memos/${created.memoId}/restore`, {
      method: 'POST',
      body: {},
    });
    assert.equal(restored.memoId, created.memoId);

    await request(key, `/memos/${created.memoId}/purge`, { method: 'DELETE', expectedStatus: 204 });
    await request(key, `/memos/${multipart.memoId}/purge`, { method: 'DELETE', expectedStatus: 204 });

    for (const imported of task.result.items) {
      await request(key, `/memos/${imported.memoId}/purge`, { method: 'DELETE', expectedStatus: 204 });
    }

    ws.close();

    const summary = {
      status,
      createdMemoId: created.memoId,
      multipartMemoId: multipart.memoId,
      multipartAttachment: multipart.attachments[0],
      importTaskId: importAccepted.taskId,
      importResult: task.result,
      wsEventTypes: wsMessages.map((item) => item.type),
      maintenance,
      stdoutTail: tail(stdoutChunks, 30),
      stderrTail: tail(stderrChunks, 30),
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    server.kill('SIGTERM');
    await onceExit(server);
  }
}

function readEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const envMap = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    envMap[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return envMap;
}

function cleanupLog(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function waitForStatus(key) {
  let lastError = null;
  for (let i = 0; i < 45; i += 1) {
    try {
      return await requestJson(key, '/status');
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }
  throw lastError || new Error('服务未启动');
}

async function createMultipartMemo(key) {
  const form = new FormData();
  form.set('content', '带附件 memo');
  form.set('tags', '["multipart","image"]');
  form.set('imageBase64', `["data:image/png;base64,${PNG_BASE64}"]`);

  const response = await fetch(`${API_BASE}/memos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

async function waitForTask(key, taskId) {
  for (let i = 0; i < 40; i += 1) {
    const task = await requestJson(key, `/tasks/${taskId}`);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    await delay(500);
  }
  throw new Error(`任务未完成: ${taskId}`);
}

async function connectMemoWs(vcpKey, messageBucket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:6005/vcp-memo-inbox/VCP_Key=${vcpKey}`);
    const timeoutId = setTimeout(() => {
      reject(new Error('WebSocket 连接超时'));
    }, 10000);

    ws.on('message', (raw) => {
      try {
        messageBucket.push(JSON.parse(String(raw)));
      } catch {
        messageBucket.push({ type: 'invalid_json', raw: String(raw) });
      }
    });

    ws.once('open', () => {
      clearTimeout(timeoutId);
      resolve(ws);
    });

    ws.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

async function waitForWsEvent(bucket, predicate) {
  for (let i = 0; i < 30; i += 1) {
    const found = bucket.find(predicate);
    if (found) {
      return found;
    }
    await delay(500);
  }
  throw new Error('未收到预期的 WebSocket 事件');
}

async function requestJson(key, route, options = {}) {
  const response = await request(key, route, options);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function request(key, route, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    Authorization: `Bearer ${key}`,
    ...(options.headers || {}),
  };
  let body = options.body;

  if (body && !(body instanceof FormData) && typeof body === 'object') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  const response = await fetch(`${API_BASE}${route}`, {
    method,
    headers,
    body,
  });

  const expectedStatus = options.expectedStatus || 200;
  if (response.status !== expectedStatus) {
    const text = await response.text();
    throw new Error(`${method} ${route} -> ${response.status}: ${text}`);
  }

  return response;
}

function tail(chunks, lineCount) {
  const text = Buffer.concat(chunks).toString('utf8');
  return text.split(/\r?\n/).filter(Boolean).slice(-lineCount);
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
