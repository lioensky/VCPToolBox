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
                prompt: 'scheduled hello'
            }
        }
    };

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
            async unlink() {}
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
        await callback(taskScheduler);
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
        assert.match(capturedCalls[0].toolArgs.prompt, /^\[预定通讯: /u);
        assert.match(capturedCalls[0].toolArgs.prompt, /scheduled hello$/u);
    });
});
