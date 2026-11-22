'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { createDebugProxy } = require('./server');

async function logDirs(root) {
  const days = await fs.readdir(root).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const dirs = [];
  for (const day of days.sort()) {
    for (const id of (await fs.readdir(path.join(root, day))).sort()) {
      dirs.push(path.join(root, day, id));
    }
  }
  return dirs;
}

async function fixture(t, { handler, bodyLimit, unusableLogRoot } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-debug-proxy-'));
  const logRoot = path.join(temp, 'logs');
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      const logsAtArrival = await logDirs(logRoot).catch(() => []);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const record = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks), logsAtArrival };
      seen.push(record);
      if (handler) return handler(record, res);
      res.writeHead(201, { 'content-type': 'application/octet-stream', 'x-upstream': 'yes' });
      res.end(record.body);
    } catch (error) {
      res.destroy(error);
    }
  });
  const start = async server => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstreamUrl = await start(upstream);
  if (unusableLogRoot) await fs.writeFile(logRoot, '');
  const proxy = createDebugProxy(`${upstreamUrl}/gateway/`, { logRoot, bodyLimit });
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { logRoot, seen, url: await start(proxy), upstreamUrl };
}

async function post(url, body, headers) {
  const response = await fetch(url, { method: 'POST', body, headers });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

test('每轮发送前独立落盘，保留精确请求体和角色顺序', async t => {
  const f = await fixture(t);
  const first = { model: 'mock', messages: [{ role: 'system', content: 'a\nb' }, { role: 'user', content: '查一下' }] };
  const second = { ...first, messages: [...first.messages, { role: 'assistant', content: '请求' }, { role: 'user', content: '回执\n下一行' }] };
  for (const body of [first, second]) {
    const raw = JSON.stringify(body, null, 1) + '\n';
    const result = await post(`${f.url}/v1/chat/completions?keep=%2F`, raw, { authorization: 'Bearer sample-secret' });
    assert.equal(result.response.status, 201);
    assert.equal(result.response.headers.get('x-upstream'), 'yes');
    assert.equal(result.body.toString(), raw);
    const arrival = f.seen.at(-1);
    assert.equal(arrival.url, '/gateway/v1/chat/completions?keep=%2F');
    assert.equal(arrival.headers.authorization, 'Bearer sample-secret');
    assert.equal(arrival.headers.host, new URL(f.upstreamUrl).host);
    assert.equal(arrival.logsAtArrival.length, f.seen.length);
    const snapshots = await Promise.all(arrival.logsAtArrival.map(dir => fs.readFile(path.join(dir, 'request.json'), 'utf8')));
    const dir = arrival.logsAtArrival[snapshots.indexOf(raw)];
    assert.ok(dir, '收到请求时，精确的 JSON 已经落盘');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['request.json', 'request.md']);
    const md = await fs.readFile(path.join(dir, 'request.md'), 'utf8');
    assert.match(md, /messages\[0\] · system/);
    assert.match(md, /\| a\n\s+\| b/);
    assert.doesNotMatch(md, /sample-secret|keep=%2F/);
    if (body === second) assert.match(md, /messages\[2\] · assistant[\s\S]*messages\[3\] · user/);
  }
});

test('Responses 解压用于日志，出站保留原始压缩字节；短路径不重写', async t => {
  const f = await fixture(t);
  const raw = '{"input":[{"role":"user","content":[{"type":"input_text","text":"一行\\n二行"}]}]}';
  const zipped = gzipSync(raw);
  for (const endpoint of ['/v1/responses', '/v1/resp', '/v1/chat']) {
    const result = await post(f.url + endpoint, zipped, { 'content-encoding': 'gzip' });
    assert.deepEqual(result.body, zipped);
    assert.equal(f.seen.at(-1).url, '/gateway' + endpoint);
    assert.equal(f.seen.at(-1).headers['content-encoding'], 'gzip');
  }
  for (const dir of await logDirs(f.logRoot)) {
    assert.equal(await fs.readFile(path.join(dir, 'request.json'), 'utf8'), raw);
    assert.match(await fs.readFile(path.join(dir, 'request.md'), 'utf8'), /input\[0\] · user[\s\S]*一行\n\s+\| 二行/);
  }
  assert.equal((await logDirs(f.logRoot)).length, 3);
});

test('向量、重排、生图和非对话路径不落盘，也不受日志大小限制', async t => {
  const f = await fixture(t, { bodyLimit: 1 });
  const raw = Buffer.from([0, 1, 255]);
  for (const endpoint of ['/v1/embeddings', '/v1/rerank', '/v1/images/generations', '/v1/responses/id/cancel']) {
    const result = await post(f.url + endpoint, raw);
    assert.equal(result.response.status, 201);
    assert.deepEqual(result.body, raw);
  }
  const result = await fetch(`${f.url}/v1/models`);
  await result.arrayBuffer();
  assert.equal(f.seen.at(-1).method, 'GET');
  assert.deepEqual(await logDirs(f.logRoot), []);
});

test('SSE 第一帧在上游结束前到达，不跟随上游重定向', { timeout: 5000 }, async t => {
  let finish;
  const f = await fixture(t, { handler: (event, res) => {
    if (event.url.endsWith('/redirect')) {
      res.writeHead(302, { location: '/elsewhere' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: [DONE]\n\n');
  } });
  const response = await fetch(`${f.url}/v1/chat/completions`, { method: 'POST', body: '{"messages":[]}' });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'data: first\n\n');
  finish();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: [DONE]\n\n');
  assert.equal((await reader.read()).done, true);
  const redirect = await fetch(`${f.url}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/elsewhere');
  assert.equal(f.seen.length, 2);
});

test('无法解析的请求仍原样转发，并保留原字节', async t => {
  const f = await fixture(t);
  const raw = Buffer.from([0xff, 0x01]);
  assert.deepEqual((await post(`${f.url}/v1/chat/completions`, raw)).body, raw);
  const [dir] = await logDirs(f.logRoot);
  const logged = JSON.parse(await fs.readFile(path.join(dir, 'request.json'), 'utf8'));
  assert.deepEqual(Buffer.from(logged.rawBodyBase64, 'base64'), raw);
});

test('对话日志无法写入或请求超限时不发上游，其他端点仍能用', async t => {
  const f = await fixture(t, { unusableLogRoot: true, bodyLimit: 32 });
  assert.equal((await post(`${f.url}/v1/chat`, '{"messages":[]}')).response.status, 500);
  assert.equal((await post(`${f.url}/v1/resp`, 'x'.repeat(33))).response.status, 413);
  const inflated = gzipSync('x'.repeat(512));
  assert.ok(inflated.length <= 32);
  assert.equal((await post(`${f.url}/v1/resp`, inflated, { 'content-encoding': 'gzip' })).response.status, 413);
  assert.equal(f.seen.length, 0);
  assert.equal((await post(`${f.url}/v1/embeddings`, 'test')).response.status, 201);
  assert.equal(f.seen.length, 1);
});

async function configuredLauncher(t, upstream, port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-debug-launch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'server.js');
  await fs.copyFile(path.join(__dirname, 'server.js'), script);
  await fs.writeFile(path.join(dir, 'config.env'), `VCP_DEBUG_PROXY_UPSTREAM=${upstream}\nVCP_DEBUG_PROXY_PORT=${port}\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^VCP_DEBUG_PROXY_(UPSTREAM|PORT)$/i.test(key)) delete env[key];
  }
  return { script, cwd: os.tmpdir(), env };
}

test('代理自动读取自身目录的环境配置，并按指定端口转发', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const { script, cwd, env } = await configuredLauncher(t, f.upstreamUrl, port);
  const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.kill();
    await exited;
  });
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(([code]) => { throw new Error(`代理提前退出：${code}`); }),
  ]);
  const response = await post(`http://127.0.0.1:${port}/v1/embeddings`, 'custom port');
  assert.equal(response.body.toString(), 'custom port');
});

test('拒绝配置文件中的无效监听端口', async t => {
  const { script, cwd, env } = await configuredLauncher(t, 'http://127.0.0.1:3106', 70000);
  const result = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VCP_DEBUG_PROXY_PORT/);
});