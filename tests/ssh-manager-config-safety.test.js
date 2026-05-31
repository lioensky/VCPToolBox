const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function loadFreshSSHManagerModule() {
    const modulePath = path.join(projectRoot, 'modules', 'SSHManager', 'index.js');
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

function loadFreshSSHManagerProxyModule() {
    const modulePath = path.join(projectRoot, 'modules', 'SSHManager', 'proxy.js');
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

function assertLocalOnlyConfig(config) {
    assert.equal(config.defaultHost, 'local');
    assert.deepEqual(Object.keys(config.hosts), ['local']);
    assert.equal(config.hosts.local.type, 'local');
    assert.equal(config.hosts.local.enabled, true);
}

function withFakeNetConnection(callback) {
    const net = require('node:net');
    const originalCreateConnection = net.createConnection;
    const sockets = [];

    net.createConnection = sockPath => {
        const socket = new EventEmitter();
        socket.sockPath = sockPath;
        socket.writes = [];
        socket.destroyed = false;
        socket.setEncoding = () => {};
        socket.write = (line, cb) => {
            socket.writes.push(line);
            if (cb) cb();
        };
        socket.destroy = () => {
            socket.destroyed = true;
            socket.emit('close');
        };
        sockets.push(socket);
        return socket;
    };

    return Promise.resolve()
        .then(() => callback(sockets))
        .finally(() => {
            net.createConnection = originalCreateConnection;
            for (const socket of sockets) {
                socket.removeAllListeners();
            }
        });
}

async function waitForCondition(condition, message) {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (condition()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

test('known default SSH hosts templates resolve to local-only config', () => {
    const sshManager = loadFreshSSHManagerModule();
    const config = sshManager._private.loadHostsConfigFromPaths([
        path.join(projectRoot, 'modules', 'SSHManager', 'hosts.json'),
        path.join(projectRoot, 'Plugin', 'LinuxShellExecutor', 'hosts.json')
    ]);

    assertLocalOnlyConfig(config);
});

test('missing SSH hosts config resolves to local-only config', () => {
    const sshManager = loadFreshSSHManagerModule();
    const config = sshManager._private.loadHostsConfigFromPaths([
        path.join(os.tmpdir(), `missing-vcp-ssh-hosts-${Date.now()}.json`)
    ]);

    assertLocalOnlyConfig(config);
});

test('SSHManager proxy uses explicit token without leaking it through errors or logs', async () => {
    await withFakeNetConnection(async sockets => {
        const { SSHManagerProxy } = loadFreshSSHManagerProxyModule();
        const token = 'secret-token-r10b';
        const proxy = new SSHManagerProxy('fake-ssh-manager.sock', token);
        const socket = sockets[0];
        try {
            socket.emit('connect');

            const call = proxy.testConnection('host-a');
            await waitForCondition(
                () => socket.writes.length === 1,
                'expected proxy to write one RPC request'
            );
            const request = JSON.parse(socket.writes[0]);
            assert.equal(request.authToken, token);

            socket.emit('data', `${JSON.stringify({
                id: request.id,
                error: {
                    code: 'AUTH_FAIL',
                    message: `bad token ${token}`,
                    authToken: token
                }
            })}\n`);

            await assert.rejects(call, error => {
                assert.equal(error.code, 'AUTH_FAIL');
                assert.equal(error.message.includes(token), false);
                assert.match(error.message, /\[redacted\]/);
                return true;
            });

            proxy._log(`diagnostic ${token}`);
            assert.equal(proxy.getAndClearDebugLogs().some(line => line.includes(token)), false);
        } finally {
            proxy.destroy();
        }
    });
});

test('getSSHManager passes options.proxyAuthToken to the proxy constructor', async () => {
    await withFakeNetConnection(async sockets => {
        const previousSock = process.env.SSH_MANAGER_SOCK;
        const previousToken = process.env.SSH_MANAGER_TOKEN;
        process.env.SSH_MANAGER_SOCK = 'fake-ssh-manager.sock';
        process.env.SSH_MANAGER_TOKEN = 'env-token-r10b';

        try {
            const sshManager = loadFreshSSHManagerModule();
            const manager = sshManager.getSSHManager(null, { proxyAuthToken: 'explicit-token-r10b' });
            assert.equal(manager.authToken, 'explicit-token-r10b');
            assert.equal(sockets[0].sockPath, 'fake-ssh-manager.sock');
            manager.destroy();
        } finally {
            if (previousSock === undefined) delete process.env.SSH_MANAGER_SOCK;
            else process.env.SSH_MANAGER_SOCK = previousSock;
            if (previousToken === undefined) delete process.env.SSH_MANAGER_TOKEN;
            else process.env.SSH_MANAGER_TOKEN = previousToken;
        }
    });
});
