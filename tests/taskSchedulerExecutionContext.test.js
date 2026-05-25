const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const routePath = require.resolve('../routes/taskScheduler');

async function withTaskSchedulerStubs(callback) {
    const originalLoad = Module._load;
    const taskFileName = 'task-scheduler-context-test.json';
    const taskPayload = {
        taskId: 'task-scheduler-context-test',
        scheduledLocalTime: '2000-01-01T00:00:00.000Z',
        tool_call: {
            tool_name: 'AgentAssistant',
            arguments: {
                prompt: 'scheduled hello',
                apiKey: 'secret-token'
            }
        }
    };
    const capturedWrites = [];
    let resolveWrite;
    const writePromise = new Promise((resolve) => {
        resolveWrite = resolve;
    });

    const fakeFs = {
        constants: { F_OK: 0 },
        promises: {
            async mkdir() {},
            async readdir() {
                return [taskFileName];
            },
            async readFile() {
                return JSON.stringify(taskPayload);
            },
            async access() {},
            async unlink() {},
            async writeFile(filePath, content) {
                capturedWrites.push({ filePath, content });
                resolveWrite();
            }
        },
        watch() {
            return { close() {} };
        }
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'fs') {
            return fakeFs;
        }

        if (request === 'node-schedule') {
            return {
                scheduleJob() {
                    throw new Error('scheduleJob should not be called for expired stub tasks');
                }
            };
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    try {
        const taskScheduler = require('../routes/taskScheduler');
        await callback(taskScheduler, { capturedWrites, writePromise });
        taskScheduler.shutdown();
    } finally {
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
}

test('taskScheduler tags plugin tool calls with task-scheduler context', async () => {
    await withTaskSchedulerStubs(async (taskScheduler) => {
        let resolveCall;
        const callPromise = new Promise((resolve) => {
            resolveCall = resolve;
        });
        const capturedCalls = [];
        const pluginManager = {
            async processToolCall(toolName, toolArgs, requestIp, executionContext) {
                capturedCalls.push({ toolName, toolArgs, requestIp, executionContext });
                resolveCall();
                return { ok: true };
            }
        };
        const webSocketServer = {
            broadcast() {}
        };

        taskScheduler.initialize(pluginManager, webSocketServer, false);

        await callPromise;

        assert.equal(capturedCalls.length, 1);
        assert.equal(capturedCalls[0].toolName, 'AgentAssistant');
        assert.equal(capturedCalls[0].requestIp, null);
        assert.equal(capturedCalls[0].executionContext.requestSource, 'task-scheduler');
        assert.equal(capturedCalls[0].executionContext.taskId, 'task-scheduler-context-test');
        assert.equal(capturedCalls[0].toolArgs.prompt, 'scheduled hello');
        assert.equal(capturedCalls[0].toolArgs.__vcp_timed_call.taskId, 'task-scheduler-context-test');
    });
});

test('taskScheduler persists sanitized timed task result metadata', async () => {
    await withTaskSchedulerStubs(async (taskScheduler, { capturedWrites, writePromise }) => {
        const pluginManager = {
            async processToolCall() {
                return { ok: true, token: 'result-secret' };
            }
        };
        const webSocketServer = {
            broadcast() {}
        };

        taskScheduler.initialize(pluginManager, webSocketServer, false);

        await writePromise;

        assert.equal(capturedWrites.length, 1);
        const persistedText = capturedWrites[0].content;
        assert.doesNotMatch(persistedText, /scheduled hello/u);
        assert.doesNotMatch(persistedText, /secret-token/u);
        assert.doesNotMatch(persistedText, /result-secret/u);

        const persisted = JSON.parse(persistedText);
        assert.equal(persisted.status, 'success');
        assert.deepEqual(persisted.argumentsSummary, {
            type: 'object',
            keys: ['prompt', 'apiKey', '__vcp_timed_call'],
            keyCount: 3,
            truncated: false
        });
        assert.equal(persisted.payloadSummary.type, 'object');
        assert.equal(persisted.payloadSummary.keyCount, 2);
    });
});
