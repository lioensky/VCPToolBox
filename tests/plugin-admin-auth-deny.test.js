const { after, test } = require('node:test');
const assert = require('node:assert/strict');

const pluginManager = require('../Plugin.js');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

function parsePluginError(error) {
    assert.ok(error instanceof Error);
    return JSON.parse(error.message);
}

async function withPluginManagerState(run) {
    const originalGetDecryptedAuthCode = pluginManager._getDecryptedAuthCode;
    const originalApprovalEnabled = pluginManager.toolApprovalManager?.config?.enabled;

    try {
        if (pluginManager.toolApprovalManager?.config) {
            pluginManager.toolApprovalManager.config.enabled = false;
        }
        await run();
    } finally {
        pluginManager._getDecryptedAuthCode = originalGetDecryptedAuthCode;
        if (pluginManager.toolApprovalManager?.config && originalApprovalEnabled !== undefined) {
            pluginManager.toolApprovalManager.config.enabled = originalApprovalEnabled;
        }
    }
}

test('executePlugin rejects admin-required stdio plugin when auth code is unavailable', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'AdminStdioAuthFixture';
        const originalPlugin = pluginManager.plugins.get(pluginName);

        pluginManager._getDecryptedAuthCode = async () => null;
        pluginManager.plugins.set(pluginName, {
            name: pluginName,
            pluginType: 'synchronous',
            communication: { protocol: 'stdio', timeout: 1000 },
            entryPoint: { command: 'node -e "process.exit(99)"' },
            basePath: __dirname,
            requiresAdmin: true,
            configSchema: {}
        });

        try {
            await assert.rejects(
                () => pluginManager.executePlugin(pluginName, null),
                (error) => {
                    const payload = parsePluginError(error);
                    assert.match(payload.plugin_error, /requires admin authentication/i);
                    assert.match(payload.plugin_error, /Execution denied/i);
                    return true;
                }
            );
        } finally {
            if (originalPlugin) {
                pluginManager.plugins.set(pluginName, originalPlugin);
            } else {
                pluginManager.plugins.delete(pluginName);
            }
        }
    });
});

test('processToolCall rejects admin-required hybrid direct plugin before invoking service module', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'AdminHybridAuthFixture';
        const originalPlugin = pluginManager.plugins.get(pluginName);
        const originalServiceModule = pluginManager.serviceModules.get(pluginName);
        let invoked = false;

        pluginManager._getDecryptedAuthCode = async () => null;
        pluginManager.plugins.set(pluginName, {
            name: pluginName,
            pluginType: 'hybridservice',
            communication: { protocol: 'direct', timeout: 1000 },
            requiresAdmin: true,
            configSchema: {}
        });
        pluginManager.serviceModules.set(pluginName, {
            module: {
                async processToolCall() {
                    invoked = true;
                    return { ok: true };
                }
            }
        });

        try {
            await assert.rejects(
                () => pluginManager.processToolCall(pluginName, {}, null, null),
                (error) => {
                    const payload = parsePluginError(error);
                    assert.match(payload.plugin_error, /requires admin authentication/i);
                    assert.match(payload.plugin_error, /Execution denied/i);
                    assert.ok(payload.timestamp);
                    return true;
                }
            );
            assert.equal(invoked, false);
        } finally {
            if (originalPlugin) {
                pluginManager.plugins.set(pluginName, originalPlugin);
            } else {
                pluginManager.plugins.delete(pluginName);
            }
            if (originalServiceModule) {
                pluginManager.serviceModules.set(pluginName, originalServiceModule);
            } else {
                pluginManager.serviceModules.delete(pluginName);
            }
        }
    });
});

test('processToolCall passes decrypted auth context to admin-required hybrid direct plugin', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'AdminHybridAuthSuccessFixture';
        const originalPlugin = pluginManager.plugins.get(pluginName);
        const originalServiceModule = pluginManager.serviceModules.get(pluginName);

        pluginManager._getDecryptedAuthCode = async () => 'fake-admin-code';
        pluginManager.plugins.set(pluginName, {
            name: pluginName,
            pluginType: 'hybridservice',
            communication: { protocol: 'direct', timeout: 1000 },
            requiresAdmin: true,
            configSchema: {}
        });
        pluginManager.serviceModules.set(pluginName, {
            module: {
                async processToolCall(_args, context) {
                    return {
                        decryptedAuthCode: context.decryptedAuthCode,
                        requestSource: context.requestSource
                    };
                }
            }
        });

        try {
            const result = await pluginManager.processToolCall(pluginName, {}, null, {
                requestSource: 'node-test'
            });

            assert.equal(result.decryptedAuthCode, 'fake-admin-code');
            assert.equal(result.requestSource, 'node-test');
            assert.ok(result.timestamp);
        } finally {
            if (originalPlugin) {
                pluginManager.plugins.set(pluginName, originalPlugin);
            } else {
                pluginManager.plugins.delete(pluginName);
            }
            if (originalServiceModule) {
                pluginManager.serviceModules.set(pluginName, originalServiceModule);
            } else {
                pluginManager.serviceModules.delete(pluginName);
            }
        }
    });
});
