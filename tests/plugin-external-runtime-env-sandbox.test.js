const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const pluginManager = require('../Plugin.js');
const {
    buildExternalPluginRuntimeEnv,
    isPluginRuntimeEnvKeyDenied
} = require('../modules/pluginRuntimeEnvSandbox');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

function makeBaseEnv(overrides = {}) {
    return {
        PATH: '/usr/bin',
        Path: 'C:\\Windows\\System32',
        HOME: '/home/operator',
        USERPROFILE: 'C:\\Users\\operator',
        TEMP: 'C:\\Temp',
        TMP: 'C:\\Tmp',
        TMPDIR: '/tmp',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        NO_COLOR: '1',
        CI: 'true',
        AdminPassword: 'admin-secret',
        Key: 'generic-key',
        OPENAI_API_KEY: 'openai-secret',
        GITHUB_TOKEN: 'github-token',
        GH_TOKEN: 'gh-token',
        COOKIE: 'cookie-secret',
        SESSION_TOKEN: 'session-secret',
        PRIVATE_KEY: 'private-key',
        CUSTOM_BASE_FLAG: 'drop-me',
        ...overrides
    };
}

function makeExternalPlugin(name, overrides = {}) {
    return {
        name,
        displayName: name,
        pluginSource: 'external',
        pluginRootId: 'external:test',
        pluginRootDisplayPath: '[external]/runtime-env',
        pluginType: 'synchronous',
        communication: { protocol: 'stdio', timeout: 1000 },
        entryPoint: { command: 'node fixture.js' },
        basePath: __dirname,
        configSchema: {
            SAFE_SETTING: 'string',
            SECRET_TOKEN: 'string',
            CALLBACK_BASE_URL: 'string'
        },
        pluginSpecificEnvConfig: {
            SAFE_SETTING: 'enabled',
            SECRET_TOKEN: 'plugin-secret',
            CALLBACK_BASE_URL: 'https://callback.example.test'
        },
        ...overrides
    };
}

function makeCorePlugin(name, overrides = {}) {
    return {
        ...makeExternalPlugin(name, overrides),
        pluginSource: 'legacy',
        pluginRootId: 'core:legacy',
        pluginRootDisplayPath: '[core]/Plugin'
    };
}

function makeFakeChild(stdoutPayload = '', options = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        write() {},
        end() {}
    };
    child.kill = () => {};
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    process.nextTick(() => {
        if (options.errorMessage) {
            child.emit('error', new Error(options.errorMessage));
            return;
        }
        if (stdoutPayload) child.stdout.emit('data', stdoutPayload);
        if (options.stderrPayload) child.stderr.emit('data', options.stderrPayload);
        child.emit('exit', options.exitCode ?? 0, options.signal ?? null);
    });
    return child;
}

async function withPluginManagerState(run) {
    const originalPlugins = pluginManager.plugins;
    const originalSpawn = pluginManager._spawnPluginProcess;
    const originalGetDecryptedAuthCode = pluginManager._getDecryptedAuthCode;
    const originalProjectBasePath = pluginManager.projectBasePath;
    const originalDebugMode = pluginManager.debugMode;
    const originalEnv = {
        PATH: process.env.PATH,
        CUSTOM_BASE_FLAG: process.env.CUSTOM_BASE_FLAG,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        Key: process.env.Key,
        PLUGIN_CALLBACK_SECRET: process.env.PLUGIN_CALLBACK_SECRET,
        PORT: process.env.PORT
    };

    pluginManager.plugins = new Map();
    pluginManager.projectBasePath = 'A:\\ProjectBase';
    process.env.CUSTOM_BASE_FLAG = 'drop-me';
    process.env.OPENAI_API_KEY = 'openai-secret';
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.Key = 'global-key';
    process.env.PLUGIN_CALLBACK_SECRET = 'callback-secret';
    process.env.PORT = '5890';

    try {
        await run();
    } finally {
        pluginManager.plugins = originalPlugins;
        pluginManager._spawnPluginProcess = originalSpawn;
        pluginManager._getDecryptedAuthCode = originalGetDecryptedAuthCode;
        pluginManager.projectBasePath = originalProjectBasePath;
        pluginManager.debugMode = originalDebugMode;
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('runtime env sandbox preserves operational keys and removes base secrets', () => {
    const env = buildExternalPluginRuntimeEnv(makeBaseEnv(), {}, {});

    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.Path, 'C:\\Windows\\System32');
    assert.equal(env.HOME, '/home/operator');
    assert.equal(env.USERPROFILE, 'C:\\Users\\operator');
    assert.equal(env.TEMP, 'C:\\Temp');
    assert.equal(env.TMP, 'C:\\Tmp');
    assert.equal(env.TMPDIR, '/tmp');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.windir, 'C:\\Windows');
    assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.CI, 'true');

    assert.equal(Object.prototype.hasOwnProperty.call(env, 'CUSTOM_BASE_FLAG'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'GITHUB_TOKEN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'Key'), false);
});

test('runtime env sandbox filters plugin config and runtime injected secrets', () => {
    const env = buildExternalPluginRuntimeEnv(
        makeBaseEnv(),
        {
            SAFE_SETTING: 'enabled',
            SECRET_TOKEN: 'plugin-secret',
            API_KEY: 'plugin-api-key'
        },
        {
            PROJECT_BASE_PATH: 'A:\\ProjectBase',
            SERVER_PORT: '5890',
            VCP_REQUEST_SOURCE: 'node-test',
            PYTHONIOENCODING: 'utf-8',
            DECRYPTED_AUTH_CODE: 'auth-secret',
            IMAGESERVER_IMAGE_KEY: 'image-secret',
            SSH_MANAGER_TOKEN: 'ssh-secret'
        }
    );

    assert.equal(env.SAFE_SETTING, 'enabled');
    assert.equal(env.PROJECT_BASE_PATH, 'A:\\ProjectBase');
    assert.equal(env.SERVER_PORT, '5890');
    assert.equal(env.VCP_REQUEST_SOURCE, 'node-test');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'SECRET_TOKEN'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'API_KEY'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'DECRYPTED_AUTH_CODE'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'IMAGESERVER_IMAGE_KEY'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'SSH_MANAGER_TOKEN'), false);
});

test('runtime env deny matcher covers secret-like names', () => {
    for (const key of ['AdminPassword', 'OPENAI_API_KEY', 'SESSION_TOKEN', 'PRIVATE_KEY', 'DECRYPTED_AUTH_CODE']) {
        assert.equal(isPluginRuntimeEnvKeyDenied(key), true, `${key} should be denied`);
    }
    assert.equal(isPluginRuntimeEnvKeyDenied('SAFE_SETTING'), false);
});

test('external stdio plugin spawn receives sanitized env', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'ExternalRuntimeEnvFixture';
        const plugin = makeExternalPlugin(pluginName);
        let spawnCall = null;

        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = (command, args, options) => {
            spawnCall = { command, args, options };
            return makeFakeChild('{"status":"success","result":"ok"}\n');
        };

        const result = await pluginManager.executePlugin(pluginName, '{}', '127.0.0.1', {
            requestSource: 'node-test',
            agentAlias: 'agent-a'
        });

        assert.equal(result.status, 'success');
        assert.ok(spawnCall);
        assert.equal(spawnCall.options.env.SAFE_SETTING, 'enabled');
        assert.equal(spawnCall.options.env.CALLBACK_BASE_URL, 'https://callback.example.test');
        assert.equal(spawnCall.options.env.PROJECT_BASE_PATH, 'A:\\ProjectBase');
        assert.equal(spawnCall.options.env.SERVER_PORT, '5890');
        assert.equal(spawnCall.options.env.VCP_REQUEST_IP, '127.0.0.1');
        assert.equal(spawnCall.options.env.VCP_REQUEST_SOURCE, 'node-test');
        assert.equal(spawnCall.options.env.VCP_AGENT_ALIAS, 'agent-a');
        assert.equal(spawnCall.options.env.PYTHONIOENCODING, 'utf-8');
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'OPENAI_API_KEY'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'GITHUB_TOKEN'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'Key'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'SECRET_TOKEN'), false);
    });
});

test('external async plugin keeps configured callback base without inheriting base secrets', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'ExternalAsyncRuntimeEnvFixture';
        const plugin = makeExternalPlugin(pluginName, {
            pluginType: 'asynchronous'
        });
        let spawnCall = null;

        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = (command, args, options) => {
            spawnCall = { command, args, options };
            return makeFakeChild('{"status":"success","result":"ok"}\n');
        };

        const result = await pluginManager.executePlugin(pluginName, '{"requestId":"async-req-1"}');

        assert.equal(result.status, 'success');
        assert.ok(spawnCall);
        assert.equal(spawnCall.options.env.CALLBACK_BASE_URL, 'https://callback.example.test');
        assert.equal(spawnCall.options.env.PLUGIN_NAME_FOR_CALLBACK, pluginName);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'CALLBACK_AUTH_SECRET'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'PLUGIN_CALLBACK_URL'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'Key'), false);
    });
});

test('external static plugin spawn receives sanitized env', async () => {
    await withPluginManagerState(async () => {
        const plugin = makeExternalPlugin('ExternalStaticRuntimeEnvFixture', {
            pluginType: 'static',
            entryPoint: { command: 'node static-fixture.js' }
        });
        let spawnCall = null;

        pluginManager._spawnPluginProcess = (command, args, options) => {
            spawnCall = { command, args, options };
            return makeFakeChild('static output');
        };

        const output = await pluginManager._executeStaticPluginCommand(plugin);

        assert.equal(output, 'static output');
        assert.ok(spawnCall);
        assert.equal(spawnCall.options.env.SAFE_SETTING, 'enabled');
        assert.equal(spawnCall.options.env.PROJECT_BASE_PATH, 'A:\\ProjectBase');
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'OPENAI_API_KEY'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'SECRET_TOKEN'), false);
    });
});

test('core stdio plugin keeps legacy full process env behavior', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'CoreRuntimeEnvFixture';
        const plugin = makeCorePlugin(pluginName);
        let spawnCall = null;

        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = (command, args, options) => {
            spawnCall = { command, args, options };
            return makeFakeChild('{"status":"success","result":"ok"}\n');
        };

        const result = await pluginManager.executePlugin(pluginName, '{}');

        assert.equal(result.status, 'success');
        assert.ok(spawnCall);
        assert.equal(spawnCall.options.env.OPENAI_API_KEY, 'openai-secret');
        assert.equal(spawnCall.options.env.GITHUB_TOKEN, 'github-secret');
        assert.equal(spawnCall.options.env.Key, 'global-key');
        assert.equal(spawnCall.options.env.SECRET_TOKEN, 'plugin-secret');
    });
});

test('core async plugin debug log never prints runtime env secret values', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'CoreAsyncRuntimeEnvFixture';
        const plugin = makeCorePlugin(pluginName, { pluginType: 'asynchronous' });
        const logs = [];
        const originalLog = console.log;

        pluginManager.debugMode = true;
        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = () => makeFakeChild('{"status":"success","result":"ok"}\n');
        console.log = (...args) => logs.push(args.map(arg => String(arg)).join(' '));

        try {
            const result = await pluginManager.executePlugin(pluginName, '{}');
            assert.equal(result.status, 'success');
        } finally {
            console.log = originalLog;
        }

        const logText = logs.join('\n');
        assert.match(logText, /Core async plugin CoreAsyncRuntimeEnvFixture runtime env keys:/);
        assert.doesNotMatch(logText, /Final ENV/);
        for (const forbidden of [
            'openai-secret',
            'github-secret',
            'global-key',
            'plugin-secret',
            'OPENAI_API_KEY',
            'GITHUB_TOKEN',
            'SECRET_TOKEN'
        ]) {
            assert.equal(logText.includes(forbidden), false, `${forbidden} should not be logged`);
        }
        assert.match(logText, /redacted \d+ sensitive keys/);
    });
});

test('stdio plugin diagnostic errors and debug logs scrub secrets and paths', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'CoreRuntimeDiagnosticFixture';
        const plugin = makeCorePlugin(pluginName);
        const logs = [];
        const warnings = [];
        const originalLog = console.log;
        const originalWarn = console.warn;

        pluginManager.debugMode = true;
        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = () => makeFakeChild(
            'not json token=stdout-secret A:\\private\\stdout.txt',
            {
                stderrPayload: 'api_key=stderr-secret /home/operator/stderr.txt',
                exitCode: 1
            }
        );
        console.log = (...args) => logs.push(args.map(arg => String(arg)).join(' '));
        console.warn = (...args) => warnings.push(args.map(arg => String(arg)).join(' '));

        try {
            await assert.rejects(
                () => pluginManager.executePlugin(pluginName, '{}'),
                (error) => {
                    assert.match(error.message, /exited with code 1/);
                    assert.match(error.message, /token=\[redacted\]/);
                    assert.match(error.message, /api_key=\[redacted\]/);
                    assert.equal(error.message.includes('stdout-secret'), false);
                    assert.equal(error.message.includes('stderr-secret'), false);
                    assert.equal(error.message.includes('A:\\private'), false);
                    assert.equal(error.message.includes('/home/operator'), false);
                    return true;
                }
            );
        } finally {
            console.log = originalLog;
            console.warn = originalWarn;
        }

        const diagnosticText = `${logs.join('\n')}\n${warnings.join('\n')}`;
        assert.equal(diagnosticText.includes('stdout-secret'), false);
        assert.equal(diagnosticText.includes('stderr-secret'), false);
        assert.equal(diagnosticText.includes('A:\\private'), false);
        assert.equal(diagnosticText.includes('/home/operator'), false);
        assert.match(diagnosticText, /token=\[redacted\]/);
        assert.match(diagnosticText, /api_key=\[redacted\]/);
    });
});

test('stdio plugin startup errors scrub secrets and paths', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'CoreRuntimeStartupErrorFixture';
        const plugin = makeCorePlugin(pluginName);

        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._spawnPluginProcess = () => makeFakeChild('', {
            errorMessage: 'spawn failed token=start-secret A:\\private\\spawn.exe'
        });

        await assert.rejects(
            () => pluginManager.executePlugin(pluginName, '{}'),
            (error) => {
                assert.match(error.message, /Failed to start plugin/);
                assert.match(error.message, /token=\[redacted\]/);
                assert.equal(error.message.includes('start-secret'), false);
                assert.equal(error.message.includes('A:\\private'), false);
                return true;
            }
        );
    });
});

test('static plugin stderr diagnostics scrub secrets and paths', async () => {
    await withPluginManagerState(async () => {
        const plugin = makeExternalPlugin('ExternalStaticDiagnosticFixture', {
            pluginType: 'static',
            entryPoint: { command: 'node static-fixture.js' }
        });
        const errors = [];
        const originalError = console.error;

        pluginManager._spawnPluginProcess = () => makeFakeChild('', {
            stderrPayload: 'password=static-secret C:\\private\\static.txt',
            exitCode: 1
        });
        console.error = (...args) => errors.push(args.map(arg => String(arg)).join(' '));

        try {
            await assert.rejects(
                () => pluginManager._executeStaticPluginCommand(plugin),
                (error) => {
                    assert.match(error.message, /password=\[redacted\]/);
                    assert.equal(error.message.includes('static-secret'), false);
                    assert.equal(error.message.includes('C:\\private'), false);
                    return true;
                }
            );
        } finally {
            console.error = originalError;
        }

        const errorText = errors.join('\n');
        assert.match(errorText, /password=\[redacted\]/);
        assert.equal(errorText.includes('static-secret'), false);
        assert.equal(errorText.includes('C:\\private'), false);
    });
});

test('static plugin startup errors scrub secrets and paths', async () => {
    await withPluginManagerState(async () => {
        const plugin = makeExternalPlugin('ExternalStaticStartupErrorFixture', {
            pluginType: 'static',
            entryPoint: { command: 'node static-fixture.js' }
        });
        const errors = [];
        const originalError = console.error;

        pluginManager._spawnPluginProcess = () => makeFakeChild('', {
            errorMessage: 'spawn failed secret=static-start-secret C:\\private\\static.exe'
        });
        console.error = (...args) => errors.push(args.map(arg => String(arg)).join(' '));

        try {
            await assert.rejects(
                () => pluginManager._executeStaticPluginCommand(plugin),
                (error) => {
                    assert.match(error.message, /secret=\[redacted\]/);
                    assert.equal(error.message.includes('static-start-secret'), false);
                    assert.equal(error.message.includes('C:\\private'), false);
                    return true;
                }
            );
        } finally {
            console.error = originalError;
        }

        const errorText = errors.join('\n');
        assert.match(errorText, /secret=\[redacted\]/);
        assert.equal(errorText.includes('static-start-secret'), false);
        assert.equal(errorText.includes('C:\\private'), false);
    });
});

test('external admin-required stdio plugin is denied before auth env injection', async () => {
    await withPluginManagerState(async () => {
        const pluginName = 'ExternalAdminRuntimeEnvFixture';
        const plugin = makeExternalPlugin(pluginName, { requiresAdmin: true });
        let authRead = false;

        pluginManager.plugins.set(pluginName, plugin);
        pluginManager._getDecryptedAuthCode = async () => {
            authRead = true;
            return 'auth-secret';
        };

        await assert.rejects(
            () => pluginManager.executePlugin(pluginName, '{}'),
            /cannot receive admin authentication/
        );
        assert.equal(authRead, false);
    });
});
