const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real route with in-memory filesystem doubles; never touch plugin data.
function createHarness(blocked = false) {
    let manifest = {
        name: 'Fixture',
        capabilities: {
            invocationCommands: [
                { commandIdentifier: 'Generate', description: 'original', example: 'old', other: true },
                { command: 'Legacy', description: 'legacy' }
            ]
        }
    };
    let writes = 0;
    let refreshes = 0;
    const routes = new Map();
    const router = {
        get() {},
        post(paths, handler) {
            for (const route of Array.isArray(paths) ? paths : [paths]) routes.set(route, handler);
        }
    };
    const mockFs = {
        async readdir() { return [{ name: 'FixtureFolder', isDirectory: () => true }]; },
        async readFile(file) {
            if (blocked && !file.endsWith('.block')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return JSON.stringify(manifest);
        },
        async writeFile(file, content) {
            assert.equal(file.endsWith('.block'), blocked);
            manifest = JSON.parse(content);
            writes++;
        }
    };
    const moduleDouble = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/admin/plugins.js'), 'utf8'), {
        module: moduleDouble,
        __dirname: path.join(__dirname, '../routes/admin'),
        console,
        require(name) {
            if (name === 'express') return { Router: () => router };
            if (name === 'fs') return { promises: mockFs };
            if (name === 'path') return path;
            if (name === './lib/dashboardCards') return { readPluginDashboardCards: () => [] };
            throw new Error(`Unexpected dependency: ${name}`);
        }
    });
    moduleDouble.exports({
        pluginManager: {
            async refreshPluginManifestMetadata() { refreshes++; return { refreshed: !blocked }; }
        }
    });
    return {
        get manifest() { return manifest; },
        get writes() { return writes; },
        get refreshes() { return refreshes; },
        async request(body, identifier = 'Generate', endpoint = 'metadata', pluginName = 'Fixture') {
            const result = { status: 200 };
            const res = {
                status(value) { result.status = value; return this; },
                json(value) { result.body = value; return this; }
            };
            await routes.get(`/plugins/:pluginName/commands/:commandIdentifier/${endpoint}`)(
                { params: { pluginName, commandIdentifier: identifier }, body, path: `/plugins/Fixture/commands/${identifier}/${endpoint}` },
                res
            );
            return result;
        }
    };
}

test('legacy description save preserves example and unrelated fields', async () => {
    const h = createHarness();
    assert.equal((await h.request({ description: 'updated' }, 'Generate', 'description')).status, 200);
    assert.deepEqual(h.manifest.capabilities.invocationCommands[0], {
        commandIdentifier: 'Generate', description: 'updated', example: 'old', other: true
    });
    assert.equal(h.refreshes, 1);
});

for (const blocked of [false, true]) {
    test(`example add/update/empty/remove round trip (${blocked ? 'disabled' : 'enabled'})`, async () => {
        const h = createHarness(blocked);
        const example = '<<<[TOOL_REQUEST]>>>\nprompt:「始」中文示例「末」\n<<<[END_TOOL_REQUEST]>>>';
        assert.equal((await h.request({ example }, 'Legacy')).status, 200);
        assert.equal(h.manifest.capabilities.invocationCommands[1].example, example);
        assert.equal(h.manifest.capabilities.invocationCommands[1].description, 'legacy');
        assert.equal((await h.request({ example: '' }, 'Legacy')).status, 200);
        assert.equal(h.manifest.capabilities.invocationCommands[1].example, '');
        assert.equal((await h.request({ example: null }, 'Legacy')).status, 200);
        assert.equal(Object.hasOwn(h.manifest.capabilities.invocationCommands[1], 'example'), false);
        assert.equal(h.refreshes, 3);
    });
}

test('missing example remains missing when only description changes', async () => {
    const h = createHarness();
    await h.request({ description: 'new' }, 'Legacy');
    assert.equal(Object.hasOwn(h.manifest.capabilities.invocationCommands[1], 'example'), false);
});

test('invalid requests and unknown targets do not write files', async () => {
    const h = createHarness();
    for (const body of [{}, { example: 1 }, { example: [] }, { example: {} }, { description: null }]) {
        assert.equal((await h.request(body)).status, 400);
    }
    assert.equal((await h.request({ example: 'x' }, 'Generate', 'description')).status, 400);
    assert.equal((await h.request({ example: 'x' }, 'Unknown')).status, 404);
    assert.equal((await h.request({ example: 'x' }, 'Generate', 'metadata', 'Unknown')).status, 404);
    assert.equal(h.writes, 0);
    assert.equal(h.refreshes, 0);
});