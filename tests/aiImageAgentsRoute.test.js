const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const routePath = require.resolve('../routes/admin/aiImageAgents');

async function withRouteModule(stub, run) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === '../../modules/aiImagePipelineExecutor') {
            return stub;
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[routePath];

    try {
        const routeModule = require('../routes/admin/aiImageAgents');
        await run(routeModule);
    } finally {
        Module._load = originalLoad;
        delete require.cache[routePath];
    }
}

test('aiImageAgents execute route forwards trusted admin attribution into executor options', async () => {
    const calls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = { processToolCall() {} };
        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.5',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-1',
                taskId: 'task-1',
                dryRun: false,
                confirm: true,
                operator: 'ui-operator-label',
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                },
                requestFlags: {
                    reason: 'manual approval',
                    ticket: 'AIG-42'
                }
            }
        }, {
            pluginManager,
            auditFilePath: 'A:\\tmp\\ai-image-audit.jsonl'
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].input.requestFlags, {
            execute_pipeline: true,
            confirm_external_effects: true,
            reason: 'manual approval',
            ticket: 'AIG-42'
        });
        assert.deepEqual(calls[0].input.context, {
            operator: 'ui-operator-label'
        });
        assert.equal(calls[0].options.dryRun, false);
        assert.equal(calls[0].options.pluginManager, pluginManager);
        assert.equal(calls[0].options.requestIp, '10.0.0.5');
        assert.deepEqual(calls[0].options.executionContext, {
            requestSource: 'ai-image-pipeline',
            operatorId: 'admin-root',
            taskId: 'task-1',
            invocationId: 'pipe-1'
        });
    });
});

test('aiImageAgents execute route stays dry-run when confirmation is incomplete and falls back to body operator id', async () => {
    const calls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'dry_run' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.6',
            body: {
                pipelineId: 'pipe-2',
                taskId: 'task-2',
                dryRun: false,
                confirm: false,
                operator: 'manual-operator',
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager: { processToolCall() {} }
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.dryRun, true);
        assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options, 'pluginManager'), false);
        assert.deepEqual(calls[0].options.executionContext, {
            requestSource: 'ai-image-pipeline',
            operatorId: 'manual-operator',
            taskId: 'task-2',
            invocationId: 'pipe-2'
        });
    });
});
