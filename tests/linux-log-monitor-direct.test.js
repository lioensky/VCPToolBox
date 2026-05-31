const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const modulePath = path.join(__dirname, '..', 'Plugin', 'LinuxLogMonitor', 'LinuxLogMonitor.js');
const monitorManagerPath = path.join(__dirname, '..', 'Plugin', 'LinuxLogMonitor', 'core', 'MonitorManager.js');

function loadFreshModule() {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

function createFakeManager(calls, label) {
    return {
        label,
        async init(options) {
            calls.push({ manager: label, init: options.mode });
        },
        async stopAll() {
            calls.push({ manager: label, stopAll: true });
        },
        async startMonitor(config) {
            calls.push({ manager: label, startMonitor: config });
            return 'task-123';
        },
        async sendStopSignal(taskId, options) {
            calls.push({ manager: label, sendStopSignal: { taskId, options } });
            return { success: true, method: 'direct' };
        },
        getStatus() {
            calls.push({ manager: label, getStatus: true });
            return { activeTasks: [{ taskId: 'task-123' }], source: 'memory' };
        },
        async getStatusFromFile() {
            calls.push({ manager: label, getStatusFromFile: true });
            return { activeTasks: [], source: 'file' };
        },
        listRules() {
            calls.push({ manager: label, listRules: true });
            return [{ name: 'default-rule' }];
        },
        async searchLog(params) {
            calls.push({ manager: label, searchLog: params });
            return { matches: ['line-a'] };
        },
        async lastErrors(params) {
            calls.push({ manager: label, lastErrors: params });
            return { errors: ['err-a'] };
        },
        async logStats(params) {
            calls.push({ manager: label, logStats: params });
            return { groups: [{ key: 'ERROR', count: 1 }] };
        }
    };
}

test('manifest declares hybrid direct while keeping CLI command', () => {
    const manifest = require('../Plugin/LinuxLogMonitor/plugin-manifest.json');

    assert.equal(manifest.pluginType, 'hybridservice');
    assert.equal(manifest.communication.protocol, 'direct');
    assert.equal(manifest.entryPoint.script, 'LinuxLogMonitor.js');
    assert.match(manifest.entryPoint.command, /LinuxLogMonitor\.js/);
});

test('initialize uses readonly mode and status does not start monitors', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    let managerId = 0;
    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => createFakeManager(calls, `manager-${++managerId}`));

    try {
        await linuxLogMonitor.initialize({ DebugMode: false });
        const status = await linuxLogMonitor.processToolCall({ command: 'status' });

        assert.deepEqual(status, { activeTasks: [], source: 'file' });
        assert.deepEqual(calls, [
            { manager: 'manager-1', init: 'readonly' },
            { manager: 'manager-1', getStatusFromFile: true }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
    }
});

test('readonly query commands reuse readonly manager without starting monitors', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => createFakeManager(calls, 'readonly-manager'));

    try {
        await linuxLogMonitor.initialize();
        const rules = await linuxLogMonitor.processToolCall({ command: 'list_rules' });
        const search = await linuxLogMonitor.processToolCall({
            command: 'searchLog',
            hostId: 'local',
            logPath: '/var/log/app.log',
            pattern: 'ERROR',
            lines: 5
        });
        const errors = await linuxLogMonitor.processToolCall({
            command: 'lastErrors',
            hostId: 'local',
            logPath: '/var/log/app.log',
            count: 3
        });
        const stats = await linuxLogMonitor.processToolCall({
            command: 'logStats',
            hostId: 'local',
            logPath: '/var/log/app.log',
            groupBy: 'level'
        });

        assert.deepEqual(rules, { rules: [{ name: 'default-rule' }] });
        assert.deepEqual(search, { matches: ['line-a'] });
        assert.deepEqual(errors, { errors: ['err-a'] });
        assert.deepEqual(stats, { groups: [{ key: 'ERROR', count: 1 }] });
        assert.equal(calls.some(call => call.startMonitor), false);
        assert.deepEqual(calls.filter(call => call.init), [
            { manager: 'readonly-manager', init: 'readonly' }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
    }
});

test('start transitions from readonly to full mode', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    let managerId = 0;
    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => createFakeManager(calls, `manager-${++managerId}`));

    try {
        await linuxLogMonitor.initialize();
        const result = await linuxLogMonitor.processToolCall({
            command: 'start',
            hostId: 'local',
            logPath: '/var/log/app.log',
            contextLines: 2
        });
        const status = await linuxLogMonitor.processToolCall({ command: 'status' });

        assert.equal(result.taskId, 'task-123');
        assert.equal(result.config.hostId, 'local');
        assert.deepEqual(status, { activeTasks: [{ taskId: 'task-123' }], source: 'memory' });
        assert.deepEqual(calls, [
            { manager: 'manager-1', init: 'readonly' },
            { manager: 'manager-1', stopAll: true },
            { manager: 'manager-2', init: 'full' },
            {
                manager: 'manager-2',
                startMonitor: {
                    hostId: 'local',
                    logPath: '/var/log/app.log',
                    rules: [],
                    contextLines: 2,
                    afterContextLines: 2
                }
            },
            { manager: 'manager-2', getStatus: true }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
    }
});

test('shutdown stops the current direct manager', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => createFakeManager(calls, 'manager'));

    try {
        await linuxLogMonitor.initialize();
        await linuxLogMonitor.shutdown();

        assert.deepEqual(calls, [
            { manager: 'manager', init: 'readonly' },
            { manager: 'manager', stopAll: true }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
    }
});

test('MonitorManager readonly init does not create state directory', async () => {
    delete require.cache[require.resolve(monitorManagerPath)];
    const MonitorManager = require(monitorManagerPath);
    const originalMkdir = fs.promises.mkdir;
    const mkdirPaths = [];
    fs.promises.mkdir = async dir => {
        mkdirPaths.push(path.normalize(dir));
    };

    try {
        const manager = new MonitorManager({ debug: false });
        manager._loadRules = async () => {};

        await manager.init({ mode: 'readonly' });

        assert.equal(
            mkdirPaths.some(dir => dir.endsWith(path.normalize(path.join('Plugin', 'LinuxLogMonitor', 'state')))),
            false
        );
        assert.equal(
            mkdirPaths.some(dir => dir.endsWith(path.normalize(path.join('Plugin', 'LinuxLogMonitor', 'rules')))),
            true
        );
    } finally {
        fs.promises.mkdir = originalMkdir;
    }
});

test('direct initialize bridges LogMonitor server globals into env before manager init', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    const previousSock = process.env.LOG_MONITOR_SOCK;
    const previousToken = process.env.LOG_MONITOR_TOKEN;
    const previousGlobalSock = global.__vcp_log_monitor_sock;
    const previousGlobalToken = global.__vcp_log_monitor_token;
    delete process.env.LOG_MONITOR_SOCK;
    delete process.env.LOG_MONITOR_TOKEN;
    global.__vcp_log_monitor_sock = 'fake-log-monitor.sock';
    global.__vcp_log_monitor_token = 'fake-token-r10d';

    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => ({
        async init(options) {
            calls.push({
                init: options.mode,
                sock: process.env.LOG_MONITOR_SOCK,
                token: process.env.LOG_MONITOR_TOKEN
            });
        },
        async stopAll() {}
    }));

    try {
        await linuxLogMonitor.initialize();

        assert.deepEqual(calls, [
            {
                init: 'readonly',
                sock: 'fake-log-monitor.sock',
                token: 'fake-token-r10d'
            }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
        if (previousSock === undefined) delete process.env.LOG_MONITOR_SOCK;
        else process.env.LOG_MONITOR_SOCK = previousSock;
        if (previousToken === undefined) delete process.env.LOG_MONITOR_TOKEN;
        else process.env.LOG_MONITOR_TOKEN = previousToken;
        if (previousGlobalSock === undefined) delete global.__vcp_log_monitor_sock;
        else global.__vcp_log_monitor_sock = previousGlobalSock;
        if (previousGlobalToken === undefined) delete global.__vcp_log_monitor_token;
        else global.__vcp_log_monitor_token = previousGlobalToken;
    }
});
