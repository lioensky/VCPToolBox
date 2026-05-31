const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SSHManager = require(path.join(__dirname, '..', 'modules', 'SSHManager', 'SSHManager.js'));

function createManagerWithConnection(connection) {
    const manager = Object.create(SSHManager.prototype);
    manager.connectionStatus = new Map();
    manager._log = () => {};
    manager._updateStatusCache = async () => {};
    manager.connect = async () => connection;
    return manager;
}

test('testConnection closes the returned non-pooled SSH connection', async () => {
    let endCalls = 0;
    let releaseCalls = 0;
    const connection = {
        type: 'ssh',
        hostId: 'remote-a',
        isConnected: true,
        isPooled: false,
        client: {
            end() {
                endCalls += 1;
            }
        },
        releaseSlot() {
            releaseCalls += 1;
        }
    };
    const manager = createManagerWithConnection(connection);

    const result = await manager._testConnectionInternal('remote-a');

    assert.equal(result.success, true);
    assert.equal(result.output, 'SSH_HANDSHAKE_OK');
    assert.equal(endCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(connection.isConnected, false);
    assert.equal(manager.connectionStatus.get('remote-a'), 'disconnected');
});

test('testConnection keeps pooled SSH connections open for reuse', async () => {
    let endCalls = 0;
    let releaseCalls = 0;
    const connection = {
        type: 'ssh',
        hostId: 'remote-b',
        isConnected: true,
        isPooled: true,
        client: {
            end() {
                endCalls += 1;
            }
        },
        releaseSlot() {
            releaseCalls += 1;
        }
    };
    const manager = createManagerWithConnection(connection);

    const result = await manager._testConnectionInternal('remote-b');

    assert.equal(result.success, true);
    assert.equal(endCalls, 0);
    assert.equal(releaseCalls, 0);
    assert.equal(connection.isConnected, true);
    assert.equal(manager.connectionStatus.has('remote-b'), false);
});

test('testConnection does not close local pseudo connections', async () => {
    const connection = {
        type: 'local',
        hostId: 'local'
    };
    const manager = createManagerWithConnection(connection);

    const result = await manager._testConnectionInternal('local');

    assert.equal(result.success, true);
    assert.equal(manager.connectionStatus.has('local'), false);
});
