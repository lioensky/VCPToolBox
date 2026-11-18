'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const express = require('express');
const { resultPath, taskPath, writeJson, createCallbackHandler } = require('../modules/asyncResultStore');

const sourcePath = path.resolve(__dirname, '../server.js');

// Exercise the production middleware, not a hand-written mock of its policy.
async function productionAuth(serverKey) {
    const source = await fs.readFile(sourcePath, 'utf8');
    const start = source.indexOf('// General API authentication');
    const end = source.indexOf('// Model allowlists are routing policy', start);
    assert.ok(start > 0 && end > start);
    let middleware;
    vm.runInNewContext(source.slice(start, end), {
        app: { use(fn) { middleware = fn; } }, serverKey
    });
    return middleware;
}

function post(port, route, token = 'test-key', data = { status: 'Succeed', result: 'ok' }) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const req = http.request({
            hostname: '127.0.0.1', port, path: route, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                ...(token === null ? {} : { Authorization: `Bearer ${token}` }) }
        }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('strict identifiers and single-file jail on all platforms', () => {
    const root = path.resolve(os.tmpdir(), 'callback-jail');
    for (const value of ['../escape', '..\\escape', '..', '.', '/tmp/x', 'C:\\x', 'x:y',
        '%2f', '%252f', 'x\0y', 'x y', 'x.', '', 12, {}, 'a'.repeat(121)]) {
        assert.throws(() => resultPath(root, 'Known', value), { code: 'UNSAFE_PATH' });
        assert.throws(() => resultPath(root, value, 'id'), { code: 'UNSAFE_PATH' });
        assert.throws(() => taskPath(root, value), { code: 'UNSAFE_PATH' });
    }
    assert.equal(path.dirname(resultPath(root, 'Plugin.v1', 'uuid-123_456')), root);
    assert.throws(() => taskPath(root, 'CON'), { code: 'UNSAFE_PATH' });
});

test('real HTTP decoded traversal, auth, unknown plugin, body and atomic update', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-callback-test-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'results');
    const app = express();
    app.use(await productionAuth('test-key'));
    app.use(express.json());
    let pushes = 0;
    app.post('/plugin-callback/:pluginName/:taskId', createCallbackHandler({
        root,
        pluginManager: { getPlugin: name => name === 'Known' ? { webSocketPush: { enabled: true } } : null },
        broadcast: () => { pushes++; }
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;

    for (const route of ['/plugin-callback/Known/id', '/plugin-callbackX/Known/id',
        '/PLUGIN-CALLBACK/Known/id', '/plugin-callback/x/..%2f..%2fescaped']) {
        assert.equal(await post(port, route, null), 401);
        assert.equal(await post(port, route, 'wrong'), 401);
    }
    for (const id of ['..%2f..%2fescaped', '..%5cescaped', '%252e%252e%252fescaped',
        'C%3a%5cescaped', 'name%00x', '%2fabsolute', '..', 'name%20', 'a%2fb']) {
        assert.equal(await post(port, `/plugin-callback/Known/${id}`), 400, id);
        assert.equal(await post(port, `/plugin-callback/${id}/valid`), 400, id);
    }
    assert.equal(await post(port, '/plugin-callback/Unknown/id'), 404);
    assert.equal(await post(port, '/plugin-callback/Known/id', 'test-key', []), 400);
    assert.equal(pushes, 0);
    assert.deepEqual(await fs.readdir(temporary), []);
    assert.equal(await post(port, '/plugin-callback/Known/id'), 200);
    assert.equal(await post(port, '/plugin-callback/Known/id', 'test-key', { result: 'updated' }), 200);
    assert.equal(pushes, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'Known-id.json'), 'utf8')), { result: 'updated' });
    assert.deepEqual(await fs.readdir(root), ['Known-id.json']);

    // A filesystem error must not produce success or a completion notification.
    await fs.mkdir(path.join(root, 'Known-blocked.json'));
    assert.equal(await post(port, '/plugin-callback/Known/blocked'), 500);
    assert.equal(pushes, 2);
    assert.ok(!(await fs.readdir(root)).some(name => name.endsWith('.tmp')));
});

test('empty server key fails closed', async () => {
    const auth = await productionAuth('');
    let status;
    auth({ path: '/plugin-callback/Known/id', headers: { authorization: 'Bearer ' } },
        { status(code) { status = code; return this; }, json() {} },
        () => assert.fail('empty key authorized'));
    assert.equal(status, 401);
});

test('symbolic links and root junctions cannot redirect JSON writes', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-callback-links-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'results');
    const outside = path.join(temporary, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const linkRoot = path.join(temporary, 'linked-root');
    await fs.symlink(outside, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeJson(linkRoot, resultPath(linkRoot, 'Known', 'id'), {}), { code: 'UNSAFE_PATH' });
    const destination = resultPath(root, 'Known', 'id');
    await fs.symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeJson(root, destination, {}), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(outside), []);
});

test('production call sites retain auth ordering and safe storage', async () => {
    const source = await fs.readFile(sourcePath, 'utf8');
    assert.equal((source.match(/app\.use\(specialModelRouter\)/g) || []).length, 1);
    assert.ok(source.indexOf('app.use(specialModelRouter)') > source.indexOf('// General API authentication'));
    assert.ok(!source.includes("req.path.startsWith('/plugin-callback')"));
    assert.ok(source.includes('taskPath(VCP_TIMED_CONTACTS_DIR, task_id)'));
    const ws = await fs.readFile(path.resolve(__dirname, '../WebSocketServer.js'), 'utf8');
    assert.ok(ws.includes('resultPath(VCP_ASYNC_RESULTS_DIR, pluginName, taskId)'));
    assert.ok(!ws.includes('`${pluginName}-${taskId}.json`'));
});