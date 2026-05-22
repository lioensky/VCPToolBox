const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');

const routePath = require.resolve('../routes/admin/config');

async function withConfigApp(fsStub, callback) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'fs') {
            return { promises: fsStub };
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    try {
        const createConfigRouter = require('../routes/admin/config');
        const app = express();
        app.use(express.json());
        app.use(createConfigRouter({ pluginManager: { loadPlugins() {} } }));

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

test('tool approval config route rejects semantic schema errors', async () => {
    const writes = [];

    await withConfigApp({
        async readFile() {
            throw Object.assign(new Error('not needed'), { code: 'ENOENT' });
        },
        async writeFile(...args) {
            writes.push(args);
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/tool-approval-config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                config: {
                    enabled: 'yes',
                    timeoutMinutes: 0,
                    approvalList: ['ok', '']
                }
            })
        });

        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error, 'Invalid tool approval configuration.');
        assert.deepEqual(body.details, [
            'enabled must be a boolean',
            'timeoutMinutes must be a positive number',
            'approvalList must contain only non-empty strings'
        ]);
        assert.equal(writes.length, 0);
    });
});

test('tool approval config route writes normalized canonical config', async () => {
    const writes = [];

    await withConfigApp({
        async readFile() {
            throw Object.assign(new Error('not needed'), { code: 'ENOENT' });
        },
        async writeFile(filePath, content) {
            writes.push({ filePath, content });
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/tool-approval-config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                config: {
                    enabled: true,
                    approveAll: false,
                    timeout: 9.7,
                    toolList: [' SciCalculator '],
                    debugMode: true
                }
            })
        });

        assert.equal(response.status, 200);
        assert.equal(writes.length, 1);
        assert.deepEqual(JSON.parse(writes[0].content), {
            enabled: true,
            timeoutMinutes: 9,
            approveAll: false,
            approvalList: ['SciCalculator'],
            debugMode: true
        });
    });
});

test('tool approval config route rejects typo-only payloads instead of saving defaults', async () => {
    const writes = [];

    await withConfigApp({
        async readFile() {
            throw Object.assign(new Error('not needed'), { code: 'ENOENT' });
        },
        async writeFile(...args) {
            writes.push(args);
        }
    }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/tool-approval-config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                config: {
                    enbaled: true
                }
            })
        });

        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error, 'Invalid tool approval configuration.');
        assert.deepEqual(body.details, [
            'unknown config keys: enbaled',
            'config must include at least one supported field'
        ]);
        assert.equal(writes.length, 0);
    });
});
