const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

const routePath = require.resolve('../routes/admin/system');

async function withSystemMonitorApp(pm2Stub, callback) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'pm2') {
            return pm2Stub;
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    try {
        const createSystemRouter = require('../routes/admin/system');
        const app = express();
        app.use(createSystemRouter({}));

        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            await callback(baseUrl);
        } finally {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    } finally {
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
}

test('system monitor exposes a current VCP process snapshot endpoint', async () => {
    await withSystemMonitorApp({
        list() {
            throw new Error('pm2 should not be called');
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/system-monitor/processes`);
        assert.equal(response.status, 200);

        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.source, 'process');
        assert.equal(body.processes.length, 1);
        assert.equal(body.processes[0].pid, process.pid);
        assert.equal(body.processes[0].status, 'online');
        assert.equal(body.processes[0].source, 'process');
    });
});

test('system monitor keeps the PM2 process endpoint compatible', async () => {
    await withSystemMonitorApp({
        list(callback) {
            callback(null, [{
                name: 'vcp-main',
                pid: 12345,
                pm2_env: {
                    status: 'online',
                    pm_uptime: 1777451000000,
                    restart_time: 2
                },
                monit: {
                    cpu: 3.5,
                    memory: 456789
                }
            }]);
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/system-monitor/pm2/processes`);
        assert.equal(response.status, 200);

        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.source, 'pm2');
        assert.deepEqual(body.processes, [{
            name: 'vcp-main',
            pid: 12345,
            status: 'online',
            cpu: 3.5,
            memory: 456789,
            uptime: 1777451000000,
            restarts: 2,
            source: 'pm2'
        }]);
    });
});

test('system monitor falls back to the current process when PM2 is unavailable', async () => {
    await withSystemMonitorApp({
        list(callback) {
            callback(new Error('PM2 daemon unavailable'));
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/system-monitor/pm2/processes`);
        assert.equal(response.status, 200);

        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.degraded, true);
        assert.equal(body.source, 'process');
        assert.equal(body.processes.length, 1);
        assert.equal(body.processes[0].pid, process.pid);
    });
});
