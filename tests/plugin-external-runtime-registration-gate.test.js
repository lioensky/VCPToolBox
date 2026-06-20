const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginManager = require('../Plugin.js');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-runtime-gate-'));
}

function makeExternalManifest(root, overrides = {}) {
    const name = overrides.name || 'ExternalRuntimeFixture';
    const pluginDir = path.join(root, name);
    fs.mkdirSync(pluginDir, { recursive: true });
    return {
        name,
        displayName: name,
        pluginSource: 'external',
        pluginRoot: root,
        pluginRootId: 'external:test',
        pluginRootDisplayPath: '[external]/runtime-gate',
        basePath: pluginDir,
        pluginType: 'synchronous',
        entryPoint: { command: 'node fixture.js' },
        communication: { protocol: 'stdio', timeout: 1000 },
        configSchema: {},
        ...overrides
    };
}

async function withPluginManagerState(run) {
    const originalPlugins = pluginManager.plugins;
    const originalServiceModules = pluginManager.serviceModules;
    const originalMessagePreprocessors = pluginManager.messagePreprocessors;
    const originalAllowlist = process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST;
    const originalWarn = console.warn;
    const warnings = [];

    pluginManager.plugins = new Map();
    pluginManager.serviceModules = new Map();
    pluginManager.messagePreprocessors = new Map();
    console.warn = (...args) => {
        warnings.push(args.map(String).join(' '));
    };

    try {
        delete process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST;
        await run({ warnings });
    } finally {
        pluginManager.plugins = originalPlugins;
        pluginManager.serviceModules = originalServiceModules;
        pluginManager.messagePreprocessors = originalMessagePreprocessors;
        console.warn = originalWarn;
        if (originalAllowlist === undefined) {
            delete process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST;
        } else {
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = originalAllowlist;
        }
    }
}

test('external plugin discovery does not imply runtime registration without allowlist', async () => {
    await withPluginManagerState(async ({ warnings }) => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root, {
                pluginRootId: `external:${root}`,
                pluginRootDisplayPath: root
            });
            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, false);
            assert.equal(pluginManager.plugins.has(manifest.name), false);
            assert.match(warnings.join('\n'), /external_runtime_allowlist_required/);
            assert.equal(warnings.join('\n').includes(root), false);
            assert.match(warnings.join('\n'), /\[external\]/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('explicit name and source root policy allows external stdio registration', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root);
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${manifest.name}@${root}`;

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, true);
            assert.equal(pluginManager.plugins.get(manifest.name), manifest);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('name-only and path-only policies do not register external plugin', async () => {
    await withPluginManagerState(async ({ warnings }) => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root);

            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = manifest.name;
            assert.equal(await pluginManager._registerLocalPlugin(manifest, new Map(), []), false);
            assert.equal(pluginManager.plugins.has(manifest.name), false);

            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = root;
            assert.equal(await pluginManager._registerLocalPlugin(manifest, new Map(), []), false);
            assert.equal(pluginManager.plugins.has(manifest.name), false);

            assert.match(warnings.join('\n'), /external_runtime_invalid_policy/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('external same-name plugin cannot override an existing core plugin', async () => {
    await withPluginManagerState(async ({ warnings }) => {
        const root = makeTempDir();
        try {
            const coreManifest = {
                name: 'CoreNameFixture',
                displayName: 'Core Name Fixture',
                pluginSource: 'legacy',
                pluginType: 'synchronous',
                entryPoint: { command: 'node core.js' },
                communication: { protocol: 'stdio' },
                basePath: path.join(__dirname, '..', 'Plugin', 'CoreNameFixture')
            };
            pluginManager.plugins.set(coreManifest.name, coreManifest);

            const externalManifest = makeExternalManifest(root, { name: coreManifest.name });
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${externalManifest.name}@${root}`;

            const registered = await pluginManager._registerLocalPlugin(externalManifest, new Map(), []);

            assert.equal(registered, false);
            assert.equal(pluginManager.plugins.get(coreManifest.name), coreManifest);
            assert.match(warnings.join('\n'), /external_runtime_duplicate_core_name/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('blocked external direct plugin is not required during registration', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root, {
                name: 'ExternalDirectFixture',
                pluginType: 'hybridservice',
                entryPoint: { script: 'direct-fixture.js' },
                communication: { protocol: 'direct', timeout: 1000 }
            });
            fs.writeFileSync(
                path.join(manifest.basePath, 'direct-fixture.js'),
                'throw new Error("direct fixture should not be required");\n',
                'utf8'
            );

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, false);
            assert.equal(pluginManager.plugins.has(manifest.name), false);
            assert.equal(pluginManager.serviceModules.has(manifest.name), false);
            assert.equal(pluginManager.messagePreprocessors.has(manifest.name), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('core plugin registration remains unchanged by external runtime gate', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        try {
            const manifest = {
                ...makeExternalManifest(root, { name: 'CoreRuntimeFixture' }),
                pluginSource: 'legacy',
                pluginRootId: 'core:legacy',
                pluginRootDisplayPath: '[core]/Plugin'
            };

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, true);
            assert.equal(pluginManager.plugins.get(manifest.name), manifest);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
