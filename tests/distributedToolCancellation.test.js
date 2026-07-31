const test = require('node:test');
const assert = require('node:assert/strict');
const webSocketServer = require('../WebSocketServer');

const {
    distributedServers,
    pendingToolRequests,
    rejectPendingToolRequestsForServer
} = webSocketServer.__testing;

function createFakeServer({ cancelTool = true } = {}) {
    const messages = [];
    const ws = {
        readyState: 1,
        send(payload) {
            messages.push(JSON.parse(payload));
        }
    };
    return {
        server: { ws, capabilities: { cancelTool }, tools: [] },
        messages
    };
}

function resetState() {
    for (const pending of pendingToolRequests.values()) {
        clearTimeout(pending.timeout);
    }
    pendingToolRequests.clear();
    distributedServers.clear();
}

test.beforeEach(() => {
    resetState();
    webSocketServer.setPluginManager({
        getPlugin() {
            return { communication: { timeout: 20 } };
        }
    });
});

test.afterEach(resetState);

test('timeout sends one cancel_tool only when the target declares support', async () => {
    const { server, messages } = createFakeServer({ cancelTool: true });
    distributedServers.set('server-a', server);

    await assert.rejects(
        webSocketServer.executeDistributedTool('server-a', 'demo-tool', {}, 10),
        /timed out/
    );

    assert.equal(messages.filter(message => message.type === 'execute_tool').length, 1);
    assert.equal(messages.filter(message => message.type === 'cancel_tool').length, 1);
    assert.equal(pendingToolRequests.size, 0);
});

test('disconnect rejects target pending requests without sending to a closed socket', async () => {
    const { server, messages } = createFakeServer({ cancelTool: true });
    distributedServers.set('server-a', server);

    const execution = webSocketServer.executeDistributedTool(
        'server-a',
        'demo-tool',
        {},
        5_000
    );
    rejectPendingToolRequestsForServer('server-a');

    await assert.rejects(execution, /disconnected/);
    assert.equal(messages.filter(message => message.type === 'cancel_tool').length, 0);
    assert.equal(pendingToolRequests.size, 0);
});

test('tool_result from a non-target server cannot complete another node request', async () => {
    const target = createFakeServer({ cancelTool: true });
    const other = createFakeServer({ cancelTool: true });
    distributedServers.set('server-a', target.server);
    distributedServers.set('server-b', other.server);

    const execution = webSocketServer.executeDistributedTool(
        'server-a',
        'demo-tool',
        {},
        5_000
    );
    const requestId = target.messages[0].data.requestId;

    await webSocketServer.handleDistributedServerMessage('server-b', {
        type: 'tool_result',
        data: { requestId, status: 'success', result: 'wrong-node' }
    });
    assert.equal(pendingToolRequests.has(requestId), true);

    await webSocketServer.handleDistributedServerMessage('server-a', {
        type: 'tool_result',
        data: { requestId, status: 'success', result: 'target-node' }
    });
    await assert.doesNotReject(execution);
    assert.equal(await execution, 'target-node');
});