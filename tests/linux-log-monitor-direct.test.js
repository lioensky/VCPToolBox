const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const modulePath = path.join(__dirname, '..', 'Plugin', 'LinuxLogMonitor', 'LinuxLogMonitor.js');
const monitorManagerPath = path.join(__dirname, '..', 'Plugin', 'LinuxLogMonitor', 'core', 'MonitorManager.js');
const logMonitorModulePath = path.join(__dirname, '..', 'modules', 'LogMonitor', 'index.js');

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
        async getStatusFromFile() {
            calls.push({ manager: label, getStatusFromFile: true });
            return { activeTasks: [], source: 'proxy-or-file' };
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

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
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

        assert.deepEqual(status, { activeTasks: [], source: 'proxy-or-file' });
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

test('start transitions to full mode while status stays proxy-backed', async () => {
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
        assert.deepEqual(status, { activeTasks: [], source: 'proxy-or-file' });
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
            { manager: 'manager-2', getStatusFromFile: true }
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

test('direct initialize bridges service globals into env before manager init', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    const previousLogSock = process.env.LOG_MONITOR_SOCK;
    const previousLogToken = process.env.LOG_MONITOR_TOKEN;
    const previousSshSock = process.env.SSH_MANAGER_SOCK;
    const previousSshToken = process.env.SSH_MANAGER_TOKEN;
    const previousGlobalLogSock = global.__vcp_log_monitor_sock;
    const previousGlobalLogToken = global.__vcp_log_monitor_token;
    const previousGlobalSshSock = global.__vcp_ssh_manager_sock;
    const previousGlobalSshToken = global.__vcp_ssh_manager_token;
    delete process.env.LOG_MONITOR_SOCK;
    delete process.env.LOG_MONITOR_TOKEN;
    delete process.env.SSH_MANAGER_SOCK;
    delete process.env.SSH_MANAGER_TOKEN;
    global.__vcp_log_monitor_sock = 'fake-log-monitor.sock';
    global.__vcp_log_monitor_token = 'fake-token-r10d';
    global.__vcp_ssh_manager_sock = 'fake-ssh-manager.sock';
    global.__vcp_ssh_manager_token = 'fake-ssh-token-r10d';

    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => ({
        async init(options) {
            calls.push({
                init: options.mode,
                logSock: process.env.LOG_MONITOR_SOCK,
                logToken: process.env.LOG_MONITOR_TOKEN,
                sshSock: process.env.SSH_MANAGER_SOCK,
                sshToken: process.env.SSH_MANAGER_TOKEN
            });
        },
        async stopAll() {}
    }));

    try {
        await linuxLogMonitor.initialize();

        assert.deepEqual(calls, [
            {
                init: 'readonly',
                logSock: 'fake-log-monitor.sock',
                logToken: 'fake-token-r10d',
                sshSock: 'fake-ssh-manager.sock',
                sshToken: 'fake-ssh-token-r10d'
            }
        ]);
    } finally {
        linuxLogMonitor._private.resetForTests();
        if (previousLogSock === undefined) delete process.env.LOG_MONITOR_SOCK;
        else process.env.LOG_MONITOR_SOCK = previousLogSock;
        if (previousLogToken === undefined) delete process.env.LOG_MONITOR_TOKEN;
        else process.env.LOG_MONITOR_TOKEN = previousLogToken;
        if (previousSshSock === undefined) delete process.env.SSH_MANAGER_SOCK;
        else process.env.SSH_MANAGER_SOCK = previousSshSock;
        if (previousSshToken === undefined) delete process.env.SSH_MANAGER_TOKEN;
        else process.env.SSH_MANAGER_TOKEN = previousSshToken;
        if (previousGlobalLogSock === undefined) delete global.__vcp_log_monitor_sock;
        else global.__vcp_log_monitor_sock = previousGlobalLogSock;
        if (previousGlobalLogToken === undefined) delete global.__vcp_log_monitor_token;
        else global.__vcp_log_monitor_token = previousGlobalLogToken;
        if (previousGlobalSshSock === undefined) delete global.__vcp_ssh_manager_sock;
        else global.__vcp_ssh_manager_sock = previousGlobalSshSock;
        if (previousGlobalSshToken === undefined) delete global.__vcp_ssh_manager_token;
        else global.__vcp_ssh_manager_token = previousGlobalSshToken;
    }
});

test('direct env sync resets stale LogMonitor proxy and clears absent globals', () => {
    const linuxLogMonitor = loadFreshModule();
    const logMonitorModule = require(logMonitorModulePath);
    const originalResetLogMonitorProxy = logMonitorModule.resetLogMonitorProxy;
    let resetCalls = 0;
    const previousLogSock = process.env.LOG_MONITOR_SOCK;
    const previousLogToken = process.env.LOG_MONITOR_TOKEN;
    const previousSshSock = process.env.SSH_MANAGER_SOCK;
    const previousSshToken = process.env.SSH_MANAGER_TOKEN;
    const previousGlobalLogSock = global.__vcp_log_monitor_sock;
    const previousGlobalLogToken = global.__vcp_log_monitor_token;
    const previousGlobalSshSock = global.__vcp_ssh_manager_sock;
    const previousGlobalSshToken = global.__vcp_ssh_manager_token;

    process.env.LOG_MONITOR_SOCK = 'stale-log-monitor.sock';
    process.env.LOG_MONITOR_TOKEN = 'stale-log-token';
    process.env.SSH_MANAGER_SOCK = 'stale-ssh-manager.sock';
    process.env.SSH_MANAGER_TOKEN = 'stale-ssh-token';
    global.__vcp_log_monitor_sock = 'fresh-log-monitor.sock';
    global.__vcp_log_monitor_token = 'fresh-log-token';
    global.__vcp_ssh_manager_sock = 'fresh-ssh-manager.sock';
    global.__vcp_ssh_manager_token = 'fresh-ssh-token';
    logMonitorModule.resetLogMonitorProxy = () => {
        resetCalls++;
    };

    try {
        linuxLogMonitor._private.syncLogMonitorEnvFromGlobals();

        assert.equal(resetCalls, 1);
        assert.equal(process.env.LOG_MONITOR_SOCK, 'fresh-log-monitor.sock');
        assert.equal(process.env.LOG_MONITOR_TOKEN, 'fresh-log-token');
        assert.equal(process.env.SSH_MANAGER_SOCK, 'fresh-ssh-manager.sock');
        assert.equal(process.env.SSH_MANAGER_TOKEN, 'fresh-ssh-token');

        linuxLogMonitor._private.syncLogMonitorEnvFromGlobals();
        assert.equal(resetCalls, 1);

        delete global.__vcp_log_monitor_sock;
        delete global.__vcp_log_monitor_token;
        delete global.__vcp_ssh_manager_sock;
        delete global.__vcp_ssh_manager_token;

        linuxLogMonitor._private.syncLogMonitorEnvFromGlobals();

        assert.equal(resetCalls, 2);
        assert.equal(process.env.LOG_MONITOR_SOCK, undefined);
        assert.equal(process.env.LOG_MONITOR_TOKEN, undefined);
        assert.equal(process.env.SSH_MANAGER_SOCK, undefined);
        assert.equal(process.env.SSH_MANAGER_TOKEN, undefined);
    } finally {
        linuxLogMonitor._private.resetForTests();
        logMonitorModule.resetLogMonitorProxy = originalResetLogMonitorProxy;
        if (previousLogSock === undefined) delete process.env.LOG_MONITOR_SOCK;
        else process.env.LOG_MONITOR_SOCK = previousLogSock;
        if (previousLogToken === undefined) delete process.env.LOG_MONITOR_TOKEN;
        else process.env.LOG_MONITOR_TOKEN = previousLogToken;
        if (previousSshSock === undefined) delete process.env.SSH_MANAGER_SOCK;
        else process.env.SSH_MANAGER_SOCK = previousSshSock;
        if (previousSshToken === undefined) delete process.env.SSH_MANAGER_TOKEN;
        else process.env.SSH_MANAGER_TOKEN = previousSshToken;
        if (previousGlobalLogSock === undefined) delete global.__vcp_log_monitor_sock;
        else global.__vcp_log_monitor_sock = previousGlobalLogSock;
        if (previousGlobalLogToken === undefined) delete global.__vcp_log_monitor_token;
        else global.__vcp_log_monitor_token = previousGlobalLogToken;
        if (previousGlobalSshSock === undefined) delete global.__vcp_ssh_manager_sock;
        else global.__vcp_ssh_manager_sock = previousGlobalSshSock;
        if (previousGlobalSshToken === undefined) delete global.__vcp_ssh_manager_token;
        else global.__vcp_ssh_manager_token = previousGlobalSshToken;
    }
});

test('concurrent start calls share one readonly-to-full transition', async () => {
    const linuxLogMonitor = loadFreshModule();
    const calls = [];
    let managerId = 0;
    const fullInit = createDeferred();
    linuxLogMonitor._private.setMonitorManagerFactoryForTests(() => {
        const label = `manager-${++managerId}`;
        return {
            async init(options) {
                calls.push({ manager: label, init: options.mode });
                if (options.mode === 'full') {
                    await fullInit.promise;
                }
            },
            async stopAll() {
                calls.push({ manager: label, stopAll: true });
            },
            async startMonitor(config) {
                calls.push({ manager: label, startMonitor: config.logPath });
                return `task-${config.logPath}`;
            }
        };
    });

    try {
        await linuxLogMonitor.initialize();
        const firstStart = linuxLogMonitor.processToolCall({
            command: 'start',
            hostId: 'local',
            logPath: '/var/log/one.log'
        });
        const secondStart = linuxLogMonitor.processToolCall({
            command: 'start',
            hostId: 'local',
            logPath: '/var/log/two.log'
        });

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(managerId, 2);
        assert.deepEqual(calls.filter(call => call.init), [
            { manager: 'manager-1', init: 'readonly' },
            { manager: 'manager-2', init: 'full' }
        ]);

        fullInit.resolve();
        const results = await Promise.all([firstStart, secondStart]);

        assert.deepEqual(results.map(result => result.taskId), [
            'task-/var/log/one.log',
            'task-/var/log/two.log'
        ]);
        assert.deepEqual(calls.filter(call => call.stopAll), [
            { manager: 'manager-1', stopAll: true }
        ]);
        assert.deepEqual(calls.filter(call => call.startMonitor), [
            { manager: 'manager-2', startMonitor: '/var/log/one.log' },
            { manager: 'manager-2', startMonitor: '/var/log/two.log' }
        ]);
    } finally {
        fullInit.resolve();
        linuxLogMonitor._private.resetForTests();
    }
});
