const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

const routePath = require.resolve('../routes/admin/newapiMonitor');

async function withNewApiMonitorApp(axiosStub, callback) {
    const originalLoad = Module._load;
    const originalEnv = {
        NEWAPI_MONITOR_BASE_URL: process.env.NEWAPI_MONITOR_BASE_URL,
        NEWAPI_MONITOR_ACCESS_TOKEN: process.env.NEWAPI_MONITOR_ACCESS_TOKEN,
        NEWAPI_MONITOR_API_USER_ID: process.env.NEWAPI_MONITOR_API_USER_ID,
        NEWAPI_MONITOR_TIMEOUT_MS: process.env.NEWAPI_MONITOR_TIMEOUT_MS
    };

    process.env.NEWAPI_MONITOR_BASE_URL = 'http://127.0.0.1:3000';
    process.env.NEWAPI_MONITOR_ACCESS_TOKEN = 'secret-newapi-token';
    process.env.NEWAPI_MONITOR_API_USER_ID = '1';
    process.env.NEWAPI_MONITOR_TIMEOUT_MS = '15000';

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'axios') {
            return axiosStub;
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    try {
        const createNewApiMonitorRouter = require('../routes/admin/newapiMonitor');
        const app = express();
        app.use(createNewApiMonitorRouter({}));

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

        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

test('newapi monitor logs sanitized upstream failures without auth headers', async () => {
    const capturedLogs = [];
    const originalError = console.error;

    console.error = (...args) => {
        capturedLogs.push(args);
    };

    try {
        await withNewApiMonitorApp(async (config) => {
            const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');
            error.code = 'ECONNREFUSED';
            error.config = {
                ...config,
                headers: {
                    Authorization: 'secret-newapi-token',
                    'New-Api-User': '1'
                }
            };
            error.cause = { code: 'ECONNREFUSED' };
            throw error;
        }, async (baseUrl) => {
            const response = await fetch(`${baseUrl}/newapi-monitor/summary`);
            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.success, false);
        });
    } finally {
        console.error = originalError;
    }

    assert.equal(capturedLogs.length, 1);
    assert.equal(capturedLogs[0][0], '[NewApiMonitor] summary failed:');
    assert.deepEqual(capturedLogs[0][1], {
        message: 'connect ECONNREFUSED 127.0.0.1:3000',
        code: 'ECONNREFUSED',
        causeCode: 'ECONNREFUSED',
        method: 'GET',
        url: 'http://127.0.0.1:3000/api/data/'
    });

    const serializedLog = JSON.stringify(capturedLogs);
    assert.equal(serializedLog.includes('secret-newapi-token'), false);
    assert.equal(serializedLog.includes('Authorization'), false);
    assert.equal(serializedLog.includes('New-Api-User'), false);
});
