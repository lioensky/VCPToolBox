'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), https = require('node:https'), { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const express = require('express'), auth = require('../modules/apiBearerAuth');
const source = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw Error('HOST_TEST_TIMEOUT'); await pause(15); } }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

// Copy only public code dependencies. The real PluginManager discovers just
// NativeSync in this fixture, so other business plugins cannot start.
function copyCode(root, relative, copied = new Set()) {
    if (copied.has(relative)) return; copied.add(relative);
    const file = path.resolve(source, relative), target = path.resolve(root, relative);
    assert.ok(file.startsWith(source + path.sep) && target.startsWith(root + path.sep));
    const bytes = fs.readFileSync(file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    for (const match of bytes.toString('utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const base = path.resolve(path.dirname(file), match[1]);
        const dep = [base, base + '.js', base + '.json', path.join(base, 'index.js')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
        if (dep && /\.(?:js|cjs|json)$/.test(dep)) copyCode(root, path.relative(source, dep), copied);
    }
}

test('upstream PluginManager serves durable mobile execution and native routes on an isolated HTTPS host', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sync-host-')), key = 'synthetic-host-only';
    copyCode(root, 'Plugin.js'); copyCode(root, 'Plugin/NativeSync/native-sync.js');
    fs.copyFileSync(path.join(source, 'Plugin/NativeSync/plugin-manifest.json'), path.join(root, 'Plugin/NativeSync/plugin-manifest.json'));
    const openssl = args => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', 'key.pem', '-out', 'cert.pem']);
    fs.chmodSync(path.join(root, 'key.pem'), 0o600);
    const cert = fs.readFileSync(path.join(root, 'cert.pem'));
    let releaseFirst, firstEntered = false, secondContext = false, modelCalls = 0;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const model = http.createServer(async (req, res) => {
        const chunks = []; for await (const b of req) chunks.push(b);
        const body = JSON.parse(Buffer.concat(chunks)); modelCalls++;
        assert.equal(req.headers.authorization, 'Bearer ' + key);
        assert.equal(body.messages[0].content, 'SYNTHETIC_AGENT');
        const latest = body.messages.at(-1).content;
        if (latest === 'U1') { firstEntered = true; await held; }
        if (latest === 'U2') secondContext = body.messages.some(m => m.role === 'assistant' && m.content === 'A1') && !body.messages.some(m => m.content === 'U3');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: latest === 'U1' ? 'A1' : latest === 'U2' ? 'A2' : 'B1' } }] }));
    });
    const modelPort = await listen(model), app = express(); app.set('trust proxy', true);
    const server = https.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert }, app), port = await listen(server), origin = 'https://localhost:' + port;
    Object.assign(process.env, { NativeSyncEnabled: 'true', NativeSyncDataDir: path.join(root, 'data'), NativeMobileEnabled: 'true', NativeMobileOrigin: origin, NativeMobileBackendUrl: 'http://127.0.0.1:' + modelPort, NativeMobileKeyExchangeEnabled: 'true', NativeMobileMaxConcurrency: '4', NativeMobileTopics: JSON.stringify(['A','B'].map(name => ({ key: name, ownerType: 'agent', ownerId: 'synthetic-' + name, topicId: 'topic', agentAlias: name, model: 'synthetic', agentName: name }))), Key: key, PORT: String(port), DebugMode: 'false' });
    const oldLog = console.log, oldWarn = console.warn, oldError = console.error;
    console.log = console.warn = console.error = () => {};
    let manager;
    t.after(async () => { releaseFirst(); await manager?.shutdownAllPlugins(); await manager?.toolApprovalManager.watcher?.close(); manager?.toolApprovalManager.shutdown(); await close(server); await close(model); console.log = oldLog; console.warn = oldWarn; console.error = oldError; fs.rmSync(root, { recursive: true, force: true }); });
    const plugin = require(path.join(root, 'Plugin/NativeSync/native-sync'));
    plugin.setMobileHostAuthority({ agentManager: { isAgent: () => true, getAgentPrompt: async () => 'SYNTHETIC_AGENT' }, verifyKey: async supplied => supplied === key });
    manager = require(path.join(root, 'Plugin')); manager.setProjectBasePath(root);
    await manager.loadPlugins(); assert.equal(manager.plugins.size, 1); assert.equal(plugin.snapshot().ready, true);
    // Exercise the actual added server.js wiring, not a second hand-written copy.
    const hostSource = fs.readFileSync(path.join(source, 'server.js'), 'utf8').replaceAll('\r\n', '\n');
    const binding = hostSource.slice(hostSource.indexOf('    const bindHost ='), hostSource.indexOf('    server = app.listen(port, bindHost,'));
    assert.ok(binding.includes('SERVER_BIND_HOST_MUST_BE_LOOPBACK_IPV4'));
    assert.equal(vm.runInNewContext(binding + '\nbindHost', { process: { env: {} } }), undefined);
    assert.equal(vm.runInNewContext(binding + '\nbindHost', { process: { env: { SERVER_BIND_HOST: '127.0.0.1' } } }), '127.0.0.1');
    for (const value of ['0.0.0.0', '::', '::1', 'remote.invalid']) assert.throws(() => vm.runInNewContext(binding, { process: { env: { SERVER_BIND_HOST: value } } }), /MUST_BE_LOOPBACK/);
    const mobileStart = hostSource.indexOf("app.use('/mobile',"), mobileEnd = hostSource.indexOf('\n});', mobileStart) + 4;
    assert.ok(mobileStart > 0 && mobileEnd > mobileStart);
    vm.runInNewContext(hostSource.slice(mobileStart, mobileEnd), { app, pluginManager: manager });
    app.use(express.json()); app.use(auth(key));
    manager.initializeServices(app, express.Router(), root);
    const endpointLine = hostSource.split('\n').find(line => line.includes("?.setExecutionEndpoint?.(")); assert.ok(endpointLine);
    vm.runInNewContext(endpointLine, { pluginManager: manager, bindHost: undefined, server: { address: () => ({ port: modelPort }) }, serverKey: key });
    const request = (route, { body, cookie, authorization, requestOrigin = origin } = {}) => new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, servername: 'localhost', ca: cert, path: route, method: body ? 'POST' : 'GET', agent: false, headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(authorization ? { Authorization: 'Bearer ' + key } : {}) } }, res => { const bytes = []; res.on('data', b => bytes.push(b)); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], data: JSON.parse(Buffer.concat(bytes)) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    assert.equal((await request('/api/v1/sync/status')).status, 401);
    assert.equal((await request('/mobile/api/session')).status, 401);
    assert.equal((await request('/mobile/api/connection/authenticate', { body: { serverUrl: 'http://127.0.0.1:' + modelPort, apiKey: key }, requestOrigin: 'https://evil.invalid' })).status, 403);
    const login = await request('/mobile/api/connection/authenticate', { body: { serverUrl: 'http://127.0.0.1:' + modelPort, apiKey: key } }); assert.equal(login.status, 200); const cookie = login.cookie; assert.ok(cookie);
    const session = await request('/mobile/api/session', { cookie }); assert.equal(session.data.topics.length, 2);
    const submit = (topic, id, text) => request('/mobile/api/conversations/' + topic + '/messages', { cookie, body: { requestId: id, text } });
    const first = await submit('A', 'first-request', 'U1'); assert.equal(first.status, 202); await until(() => firstEntered);
    const second = await submit('A', 'second-request', 'U2'); assert.equal(second.data.state, 'queued');
    const third = await submit('B', 'parallel-request', 'B'); assert.equal(third.status, 202);
    const jobs = async topic => (await request('/mobile/api/conversations/' + topic, { cookie })).data.executions;
    await until(async () => (await jobs('B')).find(j => j.id === third.data.id)?.state === 'completed');
    assert.equal((await jobs('A')).find(j => j.id === first.data.id).state, 'running');
    const duplicate = await submit('A', 'first-request', 'U1'); assert.equal(duplicate.data.id, first.data.id); assert.equal(duplicate.data.replayed, true);
    const native = { ownerType: 'agent', ownerId: 'synthetic-A', topicId: 'topic', msgId: 'later', deviceId: 'desktop', opId: 'later-once', action: 'upsert', baseHash: null, message: { id: 'later', role: 'user', content: 'U3', timestamp: Date.now() } };
    const pushed = await request('/api/v1/sync/push', { authorization: true, body: native }); assert.equal(pushed.status, 200);
    releaseFirst(); await until(async () => (await jobs('A')).every(j => j.state === 'completed')); assert.equal(secondContext, true); assert.equal(modelCalls, 3);
    const replay = await request('/api/plugins/NativeSync/sync/push', { authorization: true, body: native }); assert.equal(replay.data.replayed, true);
    const history = await request('/mobile/api/conversations/A', { cookie }); assert.ok(history.data.messages.some(m => m.message?.content === 'A2'));
    const pulled = await request('/api/v1/sync/pull?after_seq=0&limit=100', { authorization: true }); assert.ok(pulled.data.events.some(e => e.message?.content === 'A2'));
    const before = plugin.snapshot(); assert.equal(before.lifecycle.initialized, 1); assert.equal(before.lifecycle.namespacedRegistrations, 1); assert.equal(before.lifecycle.compatibilityRegistrations, 1);
    await plugin.shutdown(); assert.equal((await request('/api/v1/sync/status', { authorization: true })).status, 503);
    await plugin.initialize({ NativeSyncEnabled: true, NativeSyncDataDir: path.join(root, 'data') });
    assert.equal(plugin.snapshot().metrics.headSeq, before.metrics.headSeq);
    assert.equal((await request('/api/v1/sync/push', { authorization: true, body: native })).data.replayed, true);
    assert.equal(modelCalls, 3); // Reopen must not replay completed model work.
    const drainLine = hostSource.split('\n').find(line => line.includes("?.beginDrain?.()")); assert.ok(drainLine);
    vm.runInNewContext(drainLine, { pluginManager: manager });
});
