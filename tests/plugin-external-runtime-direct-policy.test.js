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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-runtime-direct-policy-'));
}

function makeExternalManifest(root, overrides = {}) {
    const name = overrides.name || 'ExternalDirectRuntimeFixture';
    const pluginDir = path.join(root, name);
    fs.mkdirSync(pluginDir, { recursive: true });
    return {
        name,
        displayName: name,
        pluginSource: 'external',
        pluginRoot: root,
        pluginRootId: `external:${root}`,
        pluginRootDisplayPath: root,
        basePath: pluginDir,
        pluginType: 'hybridservice',
        entryPoint: { script: 'direct-fixture.js' },
        communication: { protocol: 'direct', timeout: 1000 },
        configSchema: {},
        ...overrides
    };
}

function withPluginManagerState(run) {
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

    return run({ warnings }).finally(() => {
        pluginManager.plugins = originalPlugins;
        pluginManager.serviceModules = originalServiceModules;
        pluginManager.messagePreprocessors = originalMessagePreprocessors;
        console.warn = originalWarn;
        if (originalAllowlist === undefined) {
            delete process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST;
        } else {
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = originalAllowlist;
        }
    });
}

test('external direct/hybrid plugins are denied even when allowlist matches', async () => {
    await withPluginManagerState(async ({ warnings }) => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root);
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${manifest.name}@${manifest.pluginRoot}`;

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, false);
            assert.equal(pluginManager.plugins.has(manifest.name), false);
            assert.equal(pluginManager.serviceModules.has(manifest.name), false);
            assert.equal(pluginManager.messagePreprocessors.has(manifest.name), false);
            const logText = warnings.join('\n');
            assert.match(logText, /external_direct_runtime_denied|external_hybrid_runtime_denied/);
            assert.match(logText, /\[external\]/);
            assert.equal(logText.includes(root), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('external direct/hybrid with requiresAdmin stays denied', async () => {
    await withPluginManagerState(async ({ warnings }) => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root, { requiresAdmin: true });
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${manifest.name}@${manifest.pluginRoot}`;

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, false);
            assert.match(warnings.join('\n'), /external_direct_requires_admin_denied/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('denied external direct plugin is not required, initialized, or routed', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        const modulesToInitialize = [];
        const discoveredPreprocessors = new Map();

        try {
            const manifest = makeExternalManifest(root, {
                pluginType: 'messagePreprocessor',
                entryPoint: { script: 'direct-fixture.js' },
                communication: { protocol: 'direct', timeout: 1000 }
            });
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${manifest.name}@${manifest.pluginRoot}`;
            fs.writeFileSync(
                path.join(manifest.basePath, 'direct-fixture.js'),
                'throw new Error("direct fixture should never be required");\n',
                'utf8'
            );

            const registered = await pluginManager._registerLocalPlugin(manifest, discoveredPreprocessors, modulesToInitialize);

            assert.equal(registered, false);
            assert.equal(modulesToInitialize.length, 0);
            assert.equal(discoveredPreprocessors.size, 0);
            assert.equal(pluginManager.serviceModules.has(manifest.name), false);
            assert.equal(pluginManager.messagePreprocessors.has(manifest.name), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('external stdio plugin remains allowed under external allowlist', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        try {
            const manifest = makeExternalManifest(root, {
                pluginType: 'synchronous',
                entryPoint: { command: 'node fixture.js' },
                communication: { protocol: 'stdio', timeout: 1000 },
                pluginRootDisplayPath: '[external]/direct-policy-stdio'
            });
            process.env.VCP_EXTERNAL_PLUGIN_ALLOWLIST = `${manifest.name}@${manifest.pluginRoot}`;

            const registered = await pluginManager._registerLocalPlugin(manifest, new Map(), []);

            assert.equal(registered, true);
            assert.equal(pluginManager.plugins.get(manifest.name), manifest);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

test('core direct/hybrid runtime registration unchanged', async () => {
    await withPluginManagerState(async () => {
        const root = makeTempDir();
        const pluginDir = path.join(root, 'CoreDirectFixture');
        const fixturePath = path.join(pluginDir, 'direct-fixture.js');
        const modulesToInitialize = [];
        const discoveredPreprocessors = new Map();
        fs.mkdirSync(pluginDir, { recursive: true });

        try {
            const manifest = {
                name: 'CoreDirectFixture',
                displayName: 'Core Direct Fixture',
                pluginSource: 'legacy',
                pluginRoot: root,
                pluginRootId: 'core:legacy',
                pluginRootDisplayPath: '[core]/Plugin',
                basePath: pluginDir,
                pluginType: 'hybridservice',
                entryPoint: { script: 'direct-fixture.js' },
                communication: { protocol: 'direct', timeout: 1000 },
                configSchema: {}
            };

            fs.writeFileSync(
                fixturePath,
                'exports.processMessages = () => ({ called: true });\n' +
                'exports.processToolCall = () => ({ called: true });\n',
                'utf8'
            );

            const registered = await pluginManager._registerLocalPlugin(manifest, discoveredPreprocessors, modulesToInitialize);

            assert.equal(registered, true);
            assert.equal(pluginManager.plugins.get(manifest.name), manifest);
            assert.equal(modulesToInitialize.length, 1);
            assert.equal(discoveredPreprocessors.has(manifest.name), true);
            assert.equal(pluginManager.serviceModules.has(manifest.name), true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
