const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const executorPath = require.resolve('../modules/aiImagePipelineExecutor');

async function withExecutorModule(stub, run) {
    const originalLoad = Module._load;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === './aiImageExecutionAdapter') {
            return stub;
        }

        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[executorPath];

    try {
        const executorModule = require('../modules/aiImagePipelineExecutor');
        await run(executorModule);
    } finally {
        Module._load = originalLoad;
        delete require.cache[executorPath];
    }
}

test('aiImagePipelineExecutor forwards governance attribution into executeImagePlan', async () => {
    const previousAllow = process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;
    process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = 'true';

    const calls = [];
    const auditFilePath = path.join(
        os.tmpdir(),
        `ai-image-pipeline-audit-${process.pid}-${Date.now()}.jsonl`
    );

    try {
        await withExecutorModule({
            async executeImagePlan(plan, options) {
                calls.push({ plan, options });
                return {
                    ok: true,
                    images: [{ plugin: 'DoubaoGen', path: 'A:\\images\\generated.png' }],
                    errors: [],
                    steps: [{ index: 0, ok: true, plugin: 'DoubaoGen' }]
                };
            }
        }, async ({ executeAiImagePipelineV2 }) => {
            const pluginManager = { processToolCall() {} };
            const result = await executeAiImagePipelineV2({
                pipelineId: 'pipe-9',
                taskId: 'task-9',
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'trusted execution' }]
                },
                requestFlags: {
                    execute_pipeline: true,
                    confirm_external_effects: true
                }
            }, {
                dryRun: false,
                pluginManager,
                auditFilePath,
                requestIp: '10.0.0.9',
                executionContext: {
                    requestSource: 'ai-image-pipeline',
                    operatorId: 'admin-root',
                    taskId: 'task-9',
                    invocationId: 'pipe-9'
                }
            });

            assert.equal(result.ok, true);
            assert.equal(result.mode, 'real_execution');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].plan.steps[0].plugin, 'DoubaoGen');
            assert.equal(calls[0].options.pluginManager, pluginManager);
            assert.equal(calls[0].options.requestIp, '10.0.0.9');
            assert.deepEqual(calls[0].options.executionContext, {
                requestSource: 'ai-image-pipeline',
                operatorId: 'admin-root',
                taskId: 'task-9',
                invocationId: 'pipe-9'
            });

            const auditLines = fs.readFileSync(auditFilePath, 'utf8')
                .trim()
                .split(/\r?\n/);
            assert.ok(auditLines.length >= 2, 'expected safety and execution audit entries');

            const safetyEvent = JSON.parse(auditLines[0]);
            assert.equal(safetyEvent.payload.requestIp, '10.0.0.9');
            assert.deepEqual(safetyEvent.payload.executionContext, {
                requestSource: 'ai-image-pipeline',
                operatorId: 'admin-root',
                taskId: 'task-9',
                invocationId: 'pipe-9'
            });
        });
    } finally {
        if (previousAllow === undefined) {
            delete process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;
        } else {
            process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = previousAllow;
        }

        if (fs.existsSync(auditFilePath)) {
            fs.unlinkSync(auditFilePath);
        }
    }
});

test('aiImagePipelineExecutor allows exact internal env-gate bypass only when explicitly supplied', async () => {
    const previousAllow = process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;
    delete process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;

    const calls = [];
    const auditFilePath = path.join(
        os.tmpdir(),
        `ai-image-pipeline-audit-internal-${process.pid}-${Date.now()}.jsonl`
    );

    try {
        await withExecutorModule({
            async executeImagePlan(plan, options) {
                calls.push({ plan, options });
                return {
                    ok: true,
                    images: [{ plugin: 'DoubaoGen', path: 'A:\\images\\internal.png' }],
                    errors: [],
                    steps: [{ index: 0, ok: true, plugin: 'DoubaoGen' }]
                };
            }
        }, async ({ executeAiImagePipelineV2 }) => {
            const pluginManager = { processToolCall() {} };
            const result = await executeAiImagePipelineV2({
                pipelineId: 'pipe-internal',
                taskId: 'task-internal',
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'trusted internal execution' }]
                },
                requestFlags: {
                    execute_pipeline: true,
                    confirm_external_effects: true
                }
            }, {
                dryRun: false,
                pluginManager,
                auditFilePath,
                requestIp: '127.0.0.1',
                allowExecutionWithoutEnvGate: true,
                executionContext: {
                    requestSource: 'ai-image-pipeline',
                    operatorId: 'vcptoolbox-internal-serum',
                    serumBottleSecretless: true,
                    taskId: 'task-internal',
                    invocationId: 'pipe-internal'
                }
            });

            assert.equal(result.ok, true);
            assert.equal(result.mode, 'real_execution');
            assert.equal(result.safety.action, 'allow');
            assert.equal(result.safety.reasons.includes('env:AIGENT_PIPELINE_ALLOW_EXECUTION 未设为 true'), false);
            assert.equal(calls.length, 1);
        });
    } finally {
        if (previousAllow === undefined) {
            delete process.env.AIGENT_PIPELINE_ALLOW_EXECUTION;
        } else {
            process.env.AIGENT_PIPELINE_ALLOW_EXECUTION = previousAllow;
        }

        if (fs.existsSync(auditFilePath)) {
            fs.unlinkSync(auditFilePath);
        }
    }
});
