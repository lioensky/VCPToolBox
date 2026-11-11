'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const express = require('express');
const safety = require('../modules/safeFilePath');

async function fixture(t) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vcp-route-path-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    for (const dir of ['routes/admin', 'TVStxt', 'Agent', 'dailynote', 'outside', 'image',
        'Plugin/AgentDream/dream_logs', 'Plugin/VCPBridgeServer/profiles', 'ToolConfigs']) {
        await fsp.mkdir(path.join(root, dir), { recursive: true });
    }
    return root;
}

// Load real route implementations with fixed project paths redirected to a
// disposable project. Never patch global fs or access production data.
function loadRoute(name, root, extra = '') {
    const filename = path.resolve(__dirname, '..', 'routes', name);
    const nativeRequire = createRequire(filename);
    const mockManager = {
        setAgentDir() {}, async scanAgentFiles() {}, async getAllAgentFiles() { return []; }
    };
    const requireMock = id => {
        if (id === '../../modules/agentManager') return mockManager;
        if (id === '../../modules/toolboxManager') return { contentCache: new Map() };
        if (id === '@napi-rs/canvas') return {};
        return nativeRequire(id);
    };
    const module = { exports: {} };
    const virtualFile = path.join(root, 'routes', name);
    const run = vm.runInThisContext(
        `(function(require,module,exports,__dirname,__filename){${fs.readFileSync(filename, 'utf8')}\n${extra}\n})`,
        { filename }
    );
    run(requireMock, module, module.exports, path.dirname(virtualFile), virtualFile);
    return module.exports;
}

async function serve(t, router) {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return async (url, body, method = 'POST') => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method, headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { status: response.status, body: await response.json() };
    };
}

async function directoryLink(t, target, link) {
    try {
        await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
            t.diagnostic(`Directory link unavailable: ${error.code}`);
            return false;
        }
        throw error;
    }
}

test('shared resolver rejects traversal, root/prefix collisions and Windows aliases', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'TVStxt');
    for (const input of ['../escape.txt', '..\\escape.txt', 'sub/../../escape.txt',
        '/absolute.txt', '\\absolute.txt', 'C:\\escape.txt', 'C:escape.txt',
        '\\\\host\\share\\escape.txt', 'file.txt:stream', 'NUL.txt', 'con.json',
        'dir./file.txt', 'dir /file.txt', 'a\0.txt', '.', '..', '', 'a//b.txt']) {
        assert.throws(() => safety.resolveSafePath(base, input), { code: 'UNSAFE_PATH' }, input);
    }
    assert.throws(() => safety.resolveSafePath(base, 'folder/name.txt', { singleSegment: true }));
    await assert.rejects(safety.assertSafePath(base, `${base}-evil/file.txt`), { code: 'UNSAFE_PATH' });
    await assert.rejects(safety.assertSafePath(base, base), { code: 'UNSAFE_PATH' });
    assert.equal(await safety.safeFilePath(base, '中文目录/合法.md'), path.join(base, '中文目录', '合法.md'));
    assert.equal(safety.resolveSafePath(base, '', { allowRoot: true }), base);
});

test('shared checks reject parent junctions', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'TVStxt');
    if (await directoryLink(t, path.join(root, 'outside'), path.join(base, 'linked'))) {
        await assert.rejects(safety.safeFilePath(base, 'linked/new/sub.txt'), { code: 'UNSAFE_PATH' });
        assert.throws(() => safety.assertSafePathSync(base, path.join(base, 'linked', 'a.txt')),
            { code: 'UNSAFE_PATH' });
    }
});

test('shared checks reject dangling file symlinks', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'TVStxt');
    try {
        await fsp.symlink(path.join(root, 'outside', 'missing.txt'), path.join(base, 'dangling.txt'), 'file');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('File symlink creation is not permitted');
        throw error;
    }
    await assert.rejects(safety.safeFilePath(base, 'dangling.txt'), { code: 'UNSAFE_PATH' });
});

test('TVS HTTP read/write/delete reject encoded traversal and preserve external files', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'TVStxt');
    const outside = path.join(root, 'outside', 'sentinel.txt');
    await fsp.writeFile(outside, 'unchanged');
    const request = await serve(t, loadRoute('admin/tvs.js', root)({ tvsDirPath: base }));
    assert.equal((await request('/tvsvars/正常.txt', { content: 'hello' })).status, 200);
    assert.equal((await request('/tvsvars/正常.txt', undefined, 'GET')).body.content, 'hello');
    for (const name of ['../outside/sentinel.txt', '..\\outside\\sentinel.txt',
        'C:\\outside.txt', 'bad.txt:stream.txt', 'sub/file.txt', 'NUL.txt']) {
        for (const method of ['POST', 'GET', 'DELETE']) {
            const result = await request(`/tvsvars/${encodeURIComponent(name)}`, method === 'POST' ? { content: 'bad' } : undefined, method);
            assert.equal(result.status, 400, `${method} ${name}`);
        }
    }
    assert.equal(await fsp.readFile(outside, 'utf8'), 'unchanged');
    assert.equal((await request('/tvsvars/正常.txt', undefined, 'DELETE')).status, 200);
});

test('Agent and Toolbox HTTP retain nested files but reject unsafe creation and links', async t => {
    const root = await fixture(t);
    for (const type of ['agents', 'toolbox']) {
        const base = path.join(root, type === 'agents' ? 'Agent' : 'TVStxt');
        const router = loadRoute(`admin/${type}.js`, root)({ agentDirPath: base, tvsDirPath: base });
        const request = await serve(t, router);
        assert.equal((await request(`/${type}/new-file`, { fileName: '安全', folderPath: '中文/sub' })).status, 200);
        const fileUrl = type === 'agents'
            ? `/agents/${encodeURIComponent('中文/sub/安全.txt')}`
            : `/toolbox/file/${encodeURIComponent('中文/sub/安全.txt')}`;
        assert.equal((await request(fileUrl, { content: 'updated' })).status, 200);
        assert.equal((await request(fileUrl, undefined, 'GET')).body.content, 'updated');
        for (const body of [
            { fileName: '../escape.txt' }, { fileName: '..\\escape.txt' },
            { fileName: 'ok.txt', folderPath: '../outside' },
            { fileName: 'ok.txt', folderPath: '/absolute' },
            { fileName: 'ok.txt', folderPath: 'C:\\outside' },
            { fileName: 'ok.txt', folderPath: 123 }
        ]) {
            const result = await request(`/${type}/new-file`, body);
            assert.ok(result.status >= 400, `${type} ${JSON.stringify(body)}`);
        }
        const unsafeUrl = type === 'agents'
            ? `/agents/${encodeURIComponent('../outside/a.txt')}`
            : `/toolbox/file/${encodeURIComponent('../outside/a.txt')}`;
        assert.ok((await request(unsafeUrl, { content: 'bad' })).status >= 400);
        const literal = '%2e%2e%2foutside.txt';
        const literalUrl = type === 'agents'
            ? `/agents/${encodeURIComponent(literal)}`
            : `/toolbox/file/${encodeURIComponent(literal)}`;
        assert.equal((await request(literalUrl, { content: 'literal name' })).status, 200);
        assert.equal(await fsp.readFile(path.join(base, literal), 'utf8'), 'literal name');
        if (await directoryLink(t, path.join(root, 'outside'), path.join(base, 'linked'))) {
            assert.ok((await request(`/${type}/new-file`, { fileName: 'bad.txt', folderPath: 'linked' })).status >= 400);
        }
        assert.equal(fs.existsSync(path.join(root, 'outside', 'bad.txt')), false);
    }
});

test('daily note save, rename, move and batch delete reject linked directories', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'dailynote');
    const outside = path.join(root, 'outside');
    await fsp.writeFile(path.join(outside, 'sentinel.txt'), 'keep');
    await fsp.mkdir(path.join(base, 'normal'));
    await fsp.writeFile(path.join(base, 'normal', 'a.txt'), 'normal');
    if (!await directoryLink(t, outside, path.join(base, 'linked'))) return;
    const request = await serve(t, loadRoute('dailyNotesRoutes.js', root)(base, false));
    assert.equal((await request('/note/normal/a.txt', { content: 'updated' })).status, 200);
    assert.equal((await request('/note/normal/a.txt', { content: 'renamed', newFileName: 'b.txt' })).status, 200);
    assert.equal(await fsp.readFile(path.join(base, 'normal', 'b.txt'), 'utf8'), 'renamed');
    assert.equal((await request('/note/linked/sentinel.txt', { content: 'bad' })).status, 400);
    assert.equal((await request('/note/linked/sentinel.txt', { content: 'bad', newFileName: 'new.txt' })).status, 400);
    assert.equal((await request('/move', { sourceNotes: [{ folder: 'normal', file: 'a.txt' }], targetFolder: 'linked' })).status, 400);
    const deleted = await request('/delete-batch', { notesToDelete: [{ folder: 'linked', file: 'sentinel.txt' }] });
    assert.equal(deleted.body.deleted.length, 0);
    assert.equal(deleted.body.errors.length, 1);
    assert.equal(await fsp.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('dream single/batch approval rejects log traversal and external diary deletions', async t => {
    const root = await fixture(t);
    const base = path.join(root, 'dailynote');
    const logs = path.join(root, 'Plugin/AgentDream/dream_logs');
    const sentinel = path.join(root, 'outside', 'sentinel.txt');
    await fsp.writeFile(sentinel, 'keep');
    let calls = 0;
    const request = await serve(t, loadRoute('admin/dream.js', root)({
        dailyNoteRootPath: base,
        pluginManager: { async processToolCall() { calls++; return { status: 'success' }; } }
    }));
    const operation = { operationId: 'op', status: 'pending_review', type: 'delete', targetDiary: pathToFileURL(sentinel).href };
    await fsp.writeFile(path.join(logs, 'bad.json'), JSON.stringify({ operations: [operation] }));
    assert.equal((await request('/dream-logs/bad.json/operations/op', { action: 'approve' })).status, 400);
    const batch = await request('/dream-logs/batch-operations', {
        action: 'reject', operations: [{ filename: '../outside.json', operationId: 'op' }]
    });
    assert.equal(batch.body.failedCount, 1);
    assert.equal((await request(`/dream-logs/${encodeURIComponent('../outside.json')}`, undefined, 'GET')).status, 400);
    operation.type = 'merge';
    operation.sourceDiaries = [pathToFileURL(sentinel).href];
    await fsp.writeFile(path.join(logs, 'bad.json'), JSON.stringify({ operations: [operation] }));
    assert.equal((await request('/dream-logs/bad.json/operations/op', { action: 'approve' })).status, 400);
    assert.equal(calls, 0);
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'keep');
    await fsp.writeFile(path.join(base, 'valid.txt'), 'delete me');
    operation.type = 'delete';
    operation.targetDiary = pathToFileURL(path.join(base, 'valid.txt')).href;
    await fsp.writeFile(path.join(logs, 'valid.json'), JSON.stringify({ operations: [operation] }));
    assert.equal((await request('/dream-logs/valid.json/operations/op', { action: 'approve' })).status, 200);
    assert.equal(fs.existsSync(path.join(base, 'valid.txt')), false);
});

test('plugin store path join rejects sibling-prefix, upload paths and invalid manifest names', async t => {
    const root = await fixture(t);
    const factory = loadRoute('admin/pluginStore.js', root,
        'module.exports.security = { safeJoin, assertSafePluginName };');
    const { safeJoin, assertSafePluginName } = factory.security;
    const work = path.join(root, 'tmp', 'folder');
    for (const value of ['../folder-evil/file.js', 'sub/../../folder-evil/file.js',
        '..\\folder-evil\\file.js', `${work}-evil/file.js`, 'C:\\escape.js']) {
        assert.throws(() => safeJoin(work, value), { code: 'UNSAFE_PATH' });
    }
    for (const name of ['../bad', '..\\bad', 'safe.', 'NUL.txt', 'C:bad']) {
        assert.throws(() => assertSafePluginName(name));
    }
    assert.equal(safeJoin(work, 'plugin/index.js'), path.join(work, 'plugin', 'index.js'));
    assert.equal(assertSafePluginName('SafePlugin-v2'), 'SafePlugin-v2');
});

test('tool export and emoji APIs reject linked targets and Windows special paths', async t => {
    const root = await fixture(t);
    const tvs = path.join(root, 'TVStxt');
    const request = await serve(t, loadRoute('admin/toolListEditor.js', root)({
        tvsDirPath: tvs, pluginManager: { plugins: new Map() }
    }));
    assert.equal((await request('/tool-list-editor/export/正常', { tools: [] })).status, 200);
    if (await directoryLink(t, path.join(root, 'outside'), path.join(root, 'image', 'linked'))) {
        const emojis = await serve(t, loadRoute('admin/emojis.js', root)({}));
        assert.equal((await emojis('/emojis/category/create', { name: 'C:escape' })).status, 400);
        assert.ok((await emojis('/emojis/file/delete', { path: 'linked/sentinel.png' })).status >= 400);
        assert.equal((await emojis('/emojis/file/delete', { path: '../outside/a.png' })).status, 400);
    }
});