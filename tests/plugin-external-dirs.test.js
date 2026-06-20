const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginManager = require('../Plugin.js');
const { classifyExternalPluginManifest } = require('../modules/externalPluginSafetyGate');
const {
    createPluginRootResolver,
    splitPathList
} = require('../modules/pluginRootResolver');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-plugin-dirs-'));
}

function writeLegacyManifest(root, folderName, manifest) {
    const pluginDir = path.join(root, folderName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
        path.join(pluginDir, 'plugin-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
    );
    return pluginDir;
}

test('VCP_PLUGIN_DIRS parser tolerates missing, empty, semicolon, and duplicate entries', () => {
    assert.deepEqual(pluginManager._parseExternalLegacyPluginDirs(''), []);
    assert.deepEqual(pluginManager._parseExternalLegacyPluginDirs('  ;  '), []);

    const first = path.resolve(__dirname, '..', 'external-one');
    const second = path.resolve(__dirname, '..', 'external-two');
    assert.deepEqual(
        pluginManager._parseExternalLegacyPluginDirs('external-one; external-two ; external-one'),
        [first, second]
    );
    assert.deepEqual(
        pluginManager._parseExternalLegacyPluginDirs('external-one:external-two:external-one'),
        [first, second]
    );
});

test('legacy external discovery ignores missing and empty directories without changing built-in loading', async () => {
    const missingRoot = path.join(os.tmpdir(), `vcp-missing-${Date.now()}`);
    const emptyRoot = makeTempDir();

    try {
        assert.deepEqual(
            await pluginManager._discoverLegacyPluginManifestsFromDir(missingRoot, 'external'),
            []
        );
        assert.deepEqual(
            await pluginManager._discoverLegacyPluginManifestsFromDir(emptyRoot, 'external'),
            []
        );
    } finally {
        fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
});

test('legacy external discovery reads plugin-manifest.json without executing plugin code', async () => {
    const root = makeTempDir();
    const pluginDir = writeLegacyManifest(root, 'ExternalEcho', {
        name: 'ExternalEcho',
        displayName: 'External Echo',
        pluginType: 'synchronous',
        entryPoint: { command: 'node external-echo.js' },
        communication: { protocol: 'stdio', timeout: 1000 }
    });
    fs.writeFileSync(
        path.join(pluginDir, 'external-echo.js'),
        'throw new Error("should not execute during discovery");\n',
        'utf8'
    );

    try {
        const manifests = await pluginManager._discoverLegacyPluginManifestsFromDir(root, 'external');
        assert.equal(manifests.length, 1);
        assert.equal(manifests[0].name, 'ExternalEcho');
        assert.equal(manifests[0].pluginSource, 'external');
        assert.equal(manifests[0].basePath, pluginDir);
        assert.deepEqual(manifests[0].pluginSpecificEnvConfig, {});

        const safetyDecision = classifyExternalPluginManifest(manifests[0]);
        assert.equal(safetyDecision.pluginName, 'ExternalEcho');
        assert.equal(safetyDecision.isExternal, true);
        assert.equal(safetyDecision.decision, 'would_block');
        assert.equal(safetyDecision.risk, 'executes_process');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PluginManager discovers resolver legacy roots in core-first order', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'Plugin.js'), 'utf8');

    assert.match(source, /for \(const rootInfo of rootSnapshot\.legacyLoadRoots\)/);
    assert.match(source, /_discoverLegacyPluginManifestsFromDir\(\s+rootInfo\.rootPath,\s+rootInfo\.source,\s+rootInfo\s+\)/s);
    assert.match(source, /if \(this\.plugins\.has\(manifest\.name\)\) \{\s+this\._warnDuplicateLocalPluginSkipped\(manifest, this\.plugins\.get\(manifest\.name\)\);\s+continue;\s+\}\s+await this\._registerLocalPlugin\(manifest/s);

    const firstExternalRoot = makeTempDir();
    const secondExternalRoot = makeTempDir();
    const previousDirs = process.env.VCP_PLUGIN_DIRS;
    const previousAllowedRoots = process.env.VCP_PLUGIN_ALLOWED_ROOTS;

    try {
        process.env.VCP_PLUGIN_ALLOWED_ROOTS = [firstExternalRoot, secondExternalRoot].join(path.delimiter);
        process.env.VCP_PLUGIN_DIRS = [secondExternalRoot, firstExternalRoot].join(path.delimiter);

        const snapshot = pluginManager.pluginRootResolver.getPluginRootSnapshotSync();
        assert.equal(snapshot.legacyLoadRoots[0].source, 'core');
        assert.equal(snapshot.legacyLoadRoots[0].rootId, 'core:legacy');
        assert.deepEqual(
            snapshot.legacyLoadRoots.slice(1).map(rootInfo => rootInfo.rootPath),
            [secondExternalRoot, firstExternalRoot]
        );
        assert.deepEqual(
            snapshot.legacyLoadRoots.slice(1).map(rootInfo => rootInfo.source),
            ['external', 'external']
        );
    } finally {
        if (previousDirs === undefined) delete process.env.VCP_PLUGIN_DIRS;
        else process.env.VCP_PLUGIN_DIRS = previousDirs;

        if (previousAllowedRoots === undefined) delete process.env.VCP_PLUGIN_ALLOWED_ROOTS;
        else process.env.VCP_PLUGIN_ALLOWED_ROOTS = previousAllowedRoots;

        fs.rmSync(firstExternalRoot, { recursive: true, force: true });
        fs.rmSync(secondExternalRoot, { recursive: true, force: true });
    }
});

test('Jenn adapter root contract keeps external legacy roots default-off', () => {
    const projectRoot = makeTempDir();

    try {
        const resolver = createPluginRootResolver({
            projectRoot,
            env: {}
        });

        const snapshot = resolver.getPluginRootSnapshotSync();

        assert.equal(snapshot.coreLegacyRoot.source, 'core');
        assert.equal(snapshot.coreLegacyRoot.rootId, 'core:legacy');
        assert.equal(snapshot.coreLegacyRoot.rootPath, path.join(projectRoot, 'Plugin'));
        assert.equal(snapshot.coreModernRoot.source, 'core-modern');
        assert.equal(snapshot.coreModernRoot.rootId, 'core:modern');
        assert.equal(snapshot.coreModernRoot.rootPath, path.join(projectRoot, 'plugins'));
        assert.deepEqual(snapshot.externalLegacyRoots, []);
        assert.deepEqual(
            snapshot.legacyLoadRoots.map(rootInfo => rootInfo.rootId),
            ['core:legacy']
        );
        assert.deepEqual(
            snapshot.watchRoots,
            [path.join(projectRoot, 'Plugin'), path.join(projectRoot, 'plugins')]
        );
        assert.deepEqual(snapshot.diagnostics, []);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('Jenn adapter root contract requires VCP_PLUGIN_ALLOWED_ROOTS for VCP_PLUGIN_DIRS', () => {
    const projectRoot = makeTempDir();
    const externalRoot = path.join(projectRoot, 'VCPToolBox-JENN-Extensions');
    fs.mkdirSync(externalRoot, { recursive: true });

    try {
        const resolver = createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_DIRS: externalRoot
            }
        });

        const snapshot = resolver.getPluginRootSnapshotSync();

        assert.deepEqual(snapshot.externalLegacyRoots, []);
        assert.equal(snapshot.legacyLoadRoots.length, 1);
        assert.equal(snapshot.legacyLoadRoots[0].rootId, 'core:legacy');
        assert.equal(snapshot.diagnostics.length, 1);
        assert.equal(snapshot.diagnostics[0].code, 'external_roots_require_allowlist');
        assert.equal(snapshot.diagnostics[0].rootId, 'external:1');
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('Jenn adapter root contract rejects unsafe external roots', () => {
    const projectRoot = makeTempDir();
    const gitRoot = path.join(projectRoot, '.git');
    const nodeModulesRoot = path.join(projectRoot, 'node_modules');
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.mkdirSync(nodeModulesRoot, { recursive: true });

    try {
        const resolver = createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_ALLOWED_ROOTS: projectRoot,
                VCP_PLUGIN_DIRS: [
                    projectRoot,
                    gitRoot,
                    nodeModulesRoot
                ].join(path.delimiter)
            }
        });

        const snapshot = resolver.getPluginRootSnapshotSync();

        assert.deepEqual(snapshot.externalLegacyRoots, []);
        assert.deepEqual(
            snapshot.diagnostics.map(item => item.code),
            ['unsafe_external_root', 'unsafe_external_root', 'unsafe_external_root']
        );
        assert.match(snapshot.diagnostics[0].message, /project root/);
        assert.match(snapshot.diagnostics[1].message, /\.git/);
        assert.match(snapshot.diagnostics[2].message, /node_modules/);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('Jenn adapter root contract keeps core roots before external legacy roots', () => {
    const projectRoot = makeTempDir();
    const extensionsRoot = path.join(projectRoot, '..', 'VCPToolBox-JENN-Extensions');
    const localStateRoot = path.join(projectRoot, '..', 'VCPToolBox-JENN-LocalState');
    fs.mkdirSync(extensionsRoot, { recursive: true });
    fs.mkdirSync(localStateRoot, { recursive: true });

    try {
        const resolver = createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_ALLOWED_ROOTS: [extensionsRoot, localStateRoot].join(path.delimiter),
                VCP_PLUGIN_DIRS: [localStateRoot, extensionsRoot].join(path.delimiter)
            }
        });

        const snapshot = resolver.getPluginRootSnapshotSync();

        assert.equal(snapshot.coreLegacyRoot.rootId, 'core:legacy');
        assert.equal(snapshot.coreModernRoot.rootId, 'core:modern');
        assert.deepEqual(
            snapshot.legacyLoadRoots.map(rootInfo => rootInfo.rootId),
            ['core:legacy', 'external:1', 'external:2']
        );
        assert.deepEqual(
            snapshot.legacyLoadRoots.map(rootInfo => rootInfo.source),
            ['core', 'external', 'external']
        );
        assert.equal(snapshot.externalLegacyRoots[0].rootPath, path.resolve(localStateRoot));
        assert.equal(snapshot.externalLegacyRoots[1].rootPath, path.resolve(extensionsRoot));
        assert.deepEqual(
            snapshot.watchRoots,
            [
                path.join(projectRoot, 'Plugin'),
                path.join(projectRoot, 'plugins'),
                path.resolve(localStateRoot),
                path.resolve(extensionsRoot)
            ]
        );
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('Jenn adapter root contract keeps Windows-style path parsing stable', () => {
    assert.deepEqual(splitPathList('C:\\Jenn\\VCPToolBox-JENN-Extensions'), [
        'C:\\Jenn\\VCPToolBox-JENN-Extensions'
    ]);
    assert.deepEqual(
        splitPathList('C:\\Jenn\\VCPToolBox-JENN-Extensions;D:\\Jenn\\VCPToolBox-JENN-LocalState'),
        ['C:\\Jenn\\VCPToolBox-JENN-Extensions', 'D:\\Jenn\\VCPToolBox-JENN-LocalState']
    );
});

test('Jenn adapter install root must match an allowlisted external legacy root', async () => {
    const projectRoot = makeTempDir();
    const externalRoot = path.join(projectRoot, '..', 'VCPToolBox-JENN-Extensions');
    const unmanagedRoot = path.join(projectRoot, '..', 'VCPToolBox-JENN-LocalState');
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.mkdirSync(unmanagedRoot, { recursive: true });

    try {
        const defaultRoot = await createPluginRootResolver({
            projectRoot,
            env: {}
        }).getPluginStoreInstallRoot();
        assert.equal(defaultRoot.source, 'core');
        assert.equal(defaultRoot.rootId, 'core:legacy');

        await assert.rejects(
            () => createPluginRootResolver({
                projectRoot,
                env: {
                    VCP_PLUGIN_INSTALL_DIR: externalRoot
                }
            }).getPluginStoreInstallRoot(),
            { code: 'plugin_install_root_allowlist_required' }
        );

        await assert.rejects(
            () => createPluginRootResolver({
                projectRoot,
                env: {
                    VCP_PLUGIN_ALLOWED_ROOTS: [externalRoot, unmanagedRoot].join(path.delimiter),
                    VCP_PLUGIN_DIRS: externalRoot,
                    VCP_PLUGIN_INSTALL_DIR: unmanagedRoot
                }
            }).getPluginStoreInstallRoot(),
            { code: 'plugin_install_root_not_managed' }
        );

        const externalInstallRoot = await createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_ALLOWED_ROOTS: externalRoot,
                VCP_PLUGIN_DIRS: externalRoot,
                VCP_PLUGIN_INSTALL_DIR: externalRoot
            }
        }).getPluginStoreInstallRoot();

        assert.equal(externalInstallRoot.mode, 'external');
        assert.equal(externalInstallRoot.source, 'external');
        assert.equal(externalInstallRoot.rootId, 'external:1');
        assert.equal(externalInstallRoot.rootPath, fs.realpathSync(externalRoot));
        assert.equal(externalInstallRoot.allowConfigEnv, false);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('Gate 10 no-op Jenn external fixture package is discovered from the Plugin subdirectory only', async () => {
    const projectRoot = makeTempDir();
    const externalPackageRoot = path.join(projectRoot, 'VCPToolBox-JENN-Extensions');
    const externalPluginRoot = path.join(externalPackageRoot, 'Plugin');
    const localStateRoot = path.join(projectRoot, 'VCPToolBox-JENN-LocalState');
    const fixtureManifest = {
        name: 'NoopJennExternalFixture',
        displayName: 'No-op Jenn External Fixture',
        pluginType: 'synchronous',
        entryPoint: { command: 'node noop-jenn-external-fixture.js' },
        communication: { protocol: 'stdio', timeout: 1000 }
    };

    fs.mkdirSync(externalPluginRoot, { recursive: true });
    fs.mkdirSync(localStateRoot, { recursive: true });
    writeLegacyManifest(externalPluginRoot, 'NoopJennExternalFixture', fixtureManifest);
    writeLegacyManifest(localStateRoot, 'NoopJennExternalFixture', fixtureManifest);

    try {
        const resolver = createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_ALLOWED_ROOTS: externalPackageRoot,
                VCP_PLUGIN_DIRS: externalPluginRoot,
                VCP_PLUGIN_INSTALL_DIR: externalPluginRoot
            }
        });
        const snapshot = resolver.getPluginRootSnapshotSync();

        assert.deepEqual(
            snapshot.legacyLoadRoots.map(rootInfo => rootInfo.rootId),
            ['core:legacy', 'external:1']
        );
        assert.equal(snapshot.externalLegacyRoots[0].rootPath, fs.realpathSync(externalPluginRoot));
        assert.ok(snapshot.externalLegacyRoots[0].rootPath.endsWith(`${path.sep}VCPToolBox-JENN-Extensions${path.sep}Plugin`));
        assert.ok(!snapshot.legacyLoadRoots.some(rootInfo => rootInfo.rootPath === fs.realpathSync(localStateRoot)));

        const manifests = await pluginManager._discoverLegacyPluginManifestsFromDir(
            snapshot.externalLegacyRoots[0].rootPath,
            'external',
            snapshot.externalLegacyRoots[0]
        );

        assert.equal(manifests.length, 1);
        assert.equal(manifests[0].name, 'NoopJennExternalFixture');
        assert.equal(manifests[0].pluginSource, 'external');
        assert.equal(manifests[0].pluginRootId, 'external:1');
        assert.equal(
            manifests[0].basePath,
            path.join(fs.realpathSync(externalPluginRoot), 'NoopJennExternalFixture')
        );

        const externalInstallRoot = await resolver.getPluginStoreInstallRoot();
        assert.equal(externalInstallRoot.mode, 'external');
        assert.equal(externalInstallRoot.rootPath, fs.realpathSync(externalPluginRoot));

        const packageRootResolver = createPluginRootResolver({
            projectRoot,
            env: {
                VCP_PLUGIN_ALLOWED_ROOTS: externalPackageRoot,
                VCP_PLUGIN_DIRS: externalPackageRoot
            }
        });
        const packageRootSnapshot = packageRootResolver.getPluginRootSnapshotSync();
        const packageRootManifests = await pluginManager._discoverLegacyPluginManifestsFromDir(
            packageRootSnapshot.externalLegacyRoots[0].rootPath,
            'external',
            packageRootSnapshot.externalLegacyRoots[0]
        );

        assert.deepEqual(packageRootManifests, []);

        writeLegacyManifest(path.join(projectRoot, 'Plugin'), 'NoopJennExternalFixture', fixtureManifest);
        const originalResolver = pluginManager.pluginRootResolver;
        const originalSnapshot = pluginManager.lastPluginRootSnapshot;
        try {
            pluginManager.pluginRootResolver = {
                getPluginRootSnapshot: async () => ({
                    diagnostics: [],
                    legacyLoadRoots: [
                        {
                            rootId: 'core:legacy',
                            source: 'core',
                            rootPath: path.join(projectRoot, 'Plugin'),
                            displayPath: 'Plugin',
                            allowConfigEnv: true
                        },
                        snapshot.externalLegacyRoots[0]
                    ]
                })
            };

            const duplicateManifests = await pluginManager._discoverLegacyPluginManifests();
            assert.equal(duplicateManifests.length, 2);
            assert.equal(duplicateManifests[0].pluginSource, 'core');
            assert.equal(duplicateManifests[0].pluginRootId, 'core:legacy');
            assert.equal(duplicateManifests[1].pluginSource, 'external');
            assert.equal(duplicateManifests[1].pluginRootId, 'external:1');

            const pluginManagerSource = fs.readFileSync(path.join(__dirname, '..', 'Plugin.js'), 'utf8');
            assert.match(pluginManagerSource, /if \(this\.plugins\.has\(manifest\.name\)\) \{\s+this\._warnDuplicateLocalPluginSkipped\(manifest, this\.plugins\.get\(manifest\.name\)\);\s+continue;\s+\}/s);
        } finally {
            pluginManager.pluginRootResolver = originalResolver;
            pluginManager.lastPluginRootSnapshot = originalSnapshot;
        }

        const fixtureFiles = [];
        const pendingDirs = [projectRoot];
        while (pendingDirs.length > 0) {
            const currentDir = pendingDirs.pop();
            for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
                const entryPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    pendingDirs.push(entryPath);
                } else {
                    fixtureFiles.push(path.relative(projectRoot, entryPath));
                }
            }
        }

        assert.ok(fixtureFiles.length > 0);
        assert.ok(fixtureFiles.every(filePath => filePath.endsWith('plugin-manifest.json')));
        assert.ok(fixtureFiles.every(filePath => !/config\.env|\.env|log|cache|image|ToolConfigs|operator/i.test(filePath)));
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('PluginManager duplicate runtime warning is path-safe and includes root identity', () => {
    const root = makeTempDir();
    const externalRoot = path.join(root, 'external');
    const originalWarn = console.warn;
    const warnings = [];

    console.warn = (...args) => warnings.push(args.map(String).join(' '));

    try {
        pluginManager._warnDuplicateLocalPluginSkipped(
            {
                name: 'SharedLegacyPlugin',
                pluginSource: 'external',
                pluginRootId: `external:${externalRoot}`,
                pluginRootDisplayPath: externalRoot,
                basePath: path.join(externalRoot, 'SharedLegacyPlugin')
            },
            {
                name: 'SharedLegacyPlugin',
                pluginSource: 'core',
                pluginRootId: 'core:legacy',
                pluginRootDisplayPath: 'Plugin',
                basePath: path.join(root, 'core', 'SharedLegacyPlugin')
            }
        );

        const logText = warnings.join('\n');
        assert.match(logText, /duplicate_plugin_name/);
        assert.match(logText, /SharedLegacyPlugin/);
        assert.match(logText, /existing core\/core:legacy/);
        assert.match(logText, /skipped external\/external:/);
        assert.equal(logText.includes(path.resolve(root)), false);
        assert.equal(logText.includes(path.resolve(externalRoot)), false);
        assert.doesNotMatch(logText, /[A-Za-z]:\\/);
    } finally {
        console.warn = originalWarn;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('PluginManager duplicate runtime warning redacts POSIX path-style external root ids', () => {
    const originalWarn = console.warn;
    const warnings = [];

    console.warn = (...args) => warnings.push(args.map(String).join(' '));

    try {
        pluginManager._warnDuplicateLocalPluginSkipped(
            {
                name: 'SharedLegacyPlugin',
                pluginSource: 'external',
                pluginRootId: 'external:/tmp/vcp-plugin-dirs-ci/external',
                pluginRootDisplayPath: '/tmp/vcp-plugin-dirs-ci/external',
                basePath: '/tmp/vcp-plugin-dirs-ci/external/SharedLegacyPlugin'
            },
            {
                name: 'SharedLegacyPlugin',
                pluginSource: 'core',
                pluginRootId: 'core:legacy',
                pluginRootDisplayPath: 'Plugin',
                basePath: '/tmp/vcp-plugin-dirs-ci/core/SharedLegacyPlugin'
            }
        );

        const logText = warnings.join('\n');
        assert.match(logText, /skipped external\/external:path/);
        assert.equal(logText.includes('/tmp/vcp-plugin-dirs-ci'), false);
    } finally {
        console.warn = originalWarn;
    }
});

test('PluginManager discovers duplicate legacy plugin manifests in resolver order', async () => {
    const root = makeTempDir();
    const coreRoot = path.join(root, 'core');
    const externalRoot = path.join(root, 'external');
    const manifest = {
        name: 'SharedLegacyPlugin',
        displayName: 'Shared Legacy Plugin',
        pluginType: 'synchronous',
        entryPoint: { command: 'node plugin.js' },
        communication: { protocol: 'stdio', timeout: 1000 }
    };
    writeLegacyManifest(coreRoot, 'SharedLegacyPlugin', manifest);
    writeLegacyManifest(externalRoot, 'SharedLegacyPlugin', manifest);

    const originalResolver = pluginManager.pluginRootResolver;
    const originalSnapshot = pluginManager.lastPluginRootSnapshot;

    try {
        pluginManager.pluginRootResolver = {
            getPluginRootSnapshot: async () => ({
                diagnostics: [],
                legacyLoadRoots: [
                    {
                        rootId: 'core:legacy',
                        source: 'core',
                        rootPath: coreRoot,
                        displayPath: 'Plugin',
                        allowConfigEnv: true
                    },
                    {
                        rootId: 'external:1',
                        source: 'external',
                        rootPath: externalRoot,
                        displayPath: '[external]/plugins',
                        allowConfigEnv: false
                    }
                ]
            })
        };

        const manifests = await pluginManager._discoverLegacyPluginManifests();

        assert.equal(manifests.length, 2);
        assert.equal(manifests[0].name, 'SharedLegacyPlugin');
        assert.equal(manifests[0].pluginSource, 'core');
        assert.equal(manifests[0].pluginRootId, 'core:legacy');
        assert.equal(manifests[1].name, 'SharedLegacyPlugin');
        assert.equal(manifests[1].pluginSource, 'external');
        assert.equal(manifests[1].pluginRootId, 'external:1');
    } finally {
        pluginManager.pluginRootResolver = originalResolver;
        pluginManager.lastPluginRootSnapshot = originalSnapshot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
