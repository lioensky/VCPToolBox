const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function loadFreshModule() {
    const modulePath = path.join(projectRoot, 'Plugin', 'LinuxShellExecutor', 'LinuxShellExecutor.js');
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

function createFakeExecutor(calls) {
    return {
        presetExecutor: {
            isPresetCommand() { return false; },
            listPresets() { return []; }
        },
        securityLevelValidator: {
            validate() {
                return {
                    passed: true,
                    highestRiskLevel: 'read',
                    requireConfirm: false
                };
            },
            generateConfirmPrompt() {
                return { prompt: 'confirm' };
            }
        },
        astAnalyzer: {
            analyze() {
                return { passed: true, risks: [] };
            }
        },
        outputFormatter: {
            async format(output, options) {
                return { output, command: options.command };
            }
        },
        _detectPrivilegeEscalation() {
            return null;
        },
        _buildPrivilegeEscalationResponse(command, detection) {
            return { status: 'interaction_required', command, detection };
        },
        async execute(command, options) {
            calls.push({ command, options });
            return {
                output: `ok:${command}`,
                stderr: '',
                code: 0,
                duration: 7
            };
        },
        async listHosts() {
            return [];
        },
        async testConnection() {
            return { success: true };
        },
        async getConnectionStatus() {
            return { local: { type: 'local' } };
        },
        async disconnectAll() {
            calls.push({ disconnect: true });
        }
    };
}

test('LinuxShellExecutor manifest declares hybrid direct while keeping CLI command', () => {
    const manifest = require('../Plugin/LinuxShellExecutor/plugin-manifest.json');

    assert.equal(manifest.pluginType, 'hybridservice');
    assert.equal(manifest.requiresAdmin, true);
    assert.equal(manifest.communication.protocol, 'direct');
    assert.equal(manifest.entryPoint.script, 'LinuxShellExecutor.js');
    assert.match(manifest.entryPoint.command, /LinuxShellExecutor\.js/);
});

test('processToolCall rejects missing admin context before execution is initialized', async () => {
    const linuxShellExecutor = loadFreshModule();

    await assert.rejects(
        linuxShellExecutor.processToolCall({ action: 'listHosts' }, {}),
        error => {
            const payload = JSON.parse(error.message);
            assert.equal(payload.status, 'error');
            assert.match(payload.error, /admin authentication context/i);
            return true;
        }
    );
});

test('runToolCall forwards direct execution options to fake executor', async () => {
    const linuxShellExecutor = loadFreshModule();
    const calls = [];
    const controller = new AbortController();
    const result = await linuxShellExecutor.runToolCall(
        {
            command: 'ls /tmp',
            hostId: 'ssh-host-a',
            requireAdmin: '123456',
            usePool: 'false',
            timeout: 4321,
            queueWaitTimeout: 111,
            maxExecutionQueueLength: 3,
            disconnectOnCommandTimeout: 'true',
            outputFormat: 'raw'
        },
        {
            executor: createFakeExecutor(calls),
            context: {
                decryptedAuthCode: '123456',
                signal: controller.signal
            }
        }
    );

    assert.equal(result.output, 'ok:ls /tmp');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ls /tmp');
    assert.equal(calls[0].options.hostId, 'ssh-host-a');
    assert.equal(calls[0].options.timeout, 4321);
    assert.equal(calls[0].options.usePool, false);
    assert.equal(calls[0].options.queueWaitTimeout, 111);
    assert.equal(calls[0].options.maxExecutionQueueLength, 3);
    assert.equal(calls[0].options.disconnectOnCommandTimeout, true);
    assert.equal(calls[0].options.bypassWhitelist, true);
    assert.equal(calls[0].options.signal, controller.signal);
});
