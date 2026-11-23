const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const WebSocket = require('ws');
const pluginManager = require('../Plugin');
const webSocketServer = require('../WebSocketServer');

function makeDistributedManifest(name, displayName = name) {
    return {
        name,
        displayName,
        pluginType: 'hybridservice',
        entryPoint: { type: 'nodejs', script: `${name}.js` },
        communication: { protocol: 'direct', timeout: 5000 }
    };
}

function waitForEvent(emitter, eventName, timeoutMs = 2000) {
    return once(emitter, eventName, { signal: AbortSignal.timeout(timeoutMs) });
}

function waitUntil(predicate, timeoutMs = 2000, intervalMs = 15) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error('Timed out waiting for condition'));
                return;
            }
            setTimeout(check, intervalMs);
        };
        check();
    });
}

test('distributed tool reconnect takeover replaces stale serverId without affecting local plugins', () => {
    const localName = '__test_local_protected_tool__';
    const distName = '__test_dist_reconnect_tool__';
    const oldServerId = 'dist-old-zombie-1';
    const newServerId = 'dist-new-active-2';

    const originalBuildDesc = pluginManager.buildVCPDescription;
    const originalScheduleJev = pluginManager._scheduleJevRegistryRebuild;
    pluginManager.buildVCPDescription = () => {};
    pluginManager._scheduleJevRegistryRebuild = () => {};

    try {
        const localManifest = {
            name: localName,
            displayName: 'Local Tool',
            pluginType: 'synchronous',
            entryPoint: { type: 'nodejs', script: 'local.js' }
        };
        const oldManifest = makeDistributedManifest(distName, 42);
        const newManifest = makeDistributedManifest(distName, '[云端] Mac Codex');
        pluginManager.plugins.set(localName, localManifest);

        pluginManager.registerDistributedTools(oldServerId, [
            oldManifest,
            makeDistributedManifest(localName, 'Hijack Attempt')
        ]);

        assert.equal(pluginManager.plugins.get(localName), localManifest);
        assert.equal(pluginManager.plugins.get(distName).serverId, oldServerId);
        assert.equal(pluginManager.plugins.get(distName).displayName, '[云端] 42');

        // Reconnect arrives before stale zombie closes
        pluginManager.registerDistributedTools(newServerId, [newManifest]);

        const reassigned = pluginManager.plugins.get(distName);
        assert.equal(reassigned.serverId, newServerId);
        assert.notEqual(reassigned, newManifest);
        assert.equal(reassigned.entryPoint, newManifest.entryPoint);
        assert.equal(reassigned.displayName, '[云端] Mac Codex');
        assert.deepEqual(oldManifest, makeDistributedManifest(distName, 42));
        assert.deepEqual(newManifest, makeDistributedManifest(distName, '[云端] Mac Codex'));

        // Stale zombie later disconnects and unregisters its serverId
        pluginManager.unregisterAllDistributedTools(oldServerId);

        assert.equal(pluginManager.plugins.get(distName), reassigned);

        // Active server disconnects cleanly
        pluginManager.unregisterAllDistributedTools(newServerId);
        assert.equal(pluginManager.plugins.has(distName), false);
    } finally {
        pluginManager.plugins.delete(localName);
        pluginManager.plugins.delete(distName);
        pluginManager.buildVCPDescription = originalBuildDesc;
        pluginManager._scheduleJevRegistryRebuild = originalScheduleJev;
    }
});

async function startWebSocketTestServer(t, unregisterAllDistributedTools) {
    const httpServer = http.createServer();
    const connectedClients = [];
    t.after(async () => {
        for (const client of connectedClients) {
            client.once('error', () => {});
            client.terminate();
        }
        await webSocketServer.shutdown();
        if (httpServer.listening) {
            await new Promise((resolve, reject) => {
                httpServer.close(error => error ? reject(error) : resolve());
            });
        }
    });
    httpServer.listen(0, '127.0.0.1');
    await waitForEvent(httpServer, 'listening');
    const { port } = httpServer.address();

    webSocketServer.setPluginManager({
        registerDistributedTools() {},
        unregisterAllDistributedTools,
        getPlugin() {}
    });
    webSocketServer.initialize(httpServer, {
        debugMode: false,
        vcpKey: 'test-key-heartbeat',
        heartbeatEnabled: true,
        heartbeatIntervalMs: 80
    });

    return async function connect(options) {
        const client = new WebSocket(`ws://127.0.0.1:${port}/vcp-distributed-server/VCP_Key=test-key-heartbeat`, options);
        connectedClients.push(client);
        const [ack] = await waitForEvent(client, 'message');
        return { client, serverId: JSON.parse(ack.toString()).data.serverId };
    };
}

test('heartbeat terminates a silent connection and keeps clients that send pong or messages', async (t) => {
    const unregisteredServers = [];
    const connect = await startWebSocketTestServer(t, serverId => {
        unregisteredServers.push(serverId);
    });
    const pong = await connect();
    const messaging = await connect({ autoPong: false });
    let pongClientPings = 0;
    let messagingClientPings = 0;
    pong.client.on('ping', () => {
        pongClientPings++;
    });
    messaging.client.on('ping', () => {
        messagingClientPings++;
        messaging.client.send(JSON.stringify({ type: 'heartbeat' }));
    });

    // Complete the handshake, then leave pings unanswered as with a half-open connection.
    const stale = await connect({ autoPong: false });
    const { distributedServers, pendingToolRequests } = webSocketServer.__testing;
    const pendingExecution = webSocketServer.executeDistributedTool(stale.serverId, 'demo-tool', {}, 5000);
    const pendingRejection = assert.rejects(pendingExecution, /disconnected/);
    await Promise.all([pendingRejection, waitForEvent(stale.client, 'close')]);

    assert.deepEqual(unregisteredServers, [stale.serverId]);
    assert.equal(distributedServers.has(stale.serverId), false);
    assert.equal(pendingToolRequests.size, 0);
    await waitUntil(() => pongClientPings >= 2 && messagingClientPings >= 2);
    for (const { client, serverId } of [pong, messaging]) {
        assert.equal(distributedServers.has(serverId), true);
        assert.equal(client.readyState, WebSocket.OPEN);
    }
});

test('heartbeat still rejects pending requests and removes the connection if tool unregister throws', async (t) => {
    const error = new Error('test unregister failure');
    const consoleError = t.mock.method(console, 'error', () => {});
    const connect = await startWebSocketTestServer(t, () => { throw error; });
    const stale = await connect({ autoPong: false });
    const { distributedServers, pendingToolRequests } = webSocketServer.__testing;

    const pendingExecution = webSocketServer.executeDistributedTool(stale.serverId, 'demo-tool', {}, 5000);
    await assert.rejects(pendingExecution, /disconnected/);
    assert.equal(distributedServers.has(stale.serverId), false);
    assert.equal(pendingToolRequests.size, 0);
    assert.equal(consoleError.mock.calls[0].arguments[1], error);
});

test.after(() => {
    pluginManager.toolApprovalManager.shutdown();
});
