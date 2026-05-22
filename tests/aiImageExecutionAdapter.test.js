const assert = require('node:assert/strict');
const test = require('node:test');

const { executeImagePlan } = require('../modules/aiImageExecutionAdapter');

test('executeImagePlan passes ai-image-pipeline as requestSource', async () => {
    const calls = [];
    const pluginManager = {
        async processToolCall(toolName, toolArgs, requestIp, executionContext) {
            calls.push({ toolName, toolArgs, requestIp, executionContext });
            return { url: 'https://example.test/generated-image.png' };
        }
    };

    const result = await executeImagePlan({
        steps: [{
            type: 'generate_image',
            plugin: 'FluxGen',
            prompt: 'governance context smoke test'
        }]
    }, { pluginManager });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'FluxGen');
    assert.deepEqual(calls[0].toolArgs, {
        command: 'FluxGenerateImage',
        prompt: 'governance context smoke test'
    });
    assert.equal(calls[0].requestIp, '127.0.0.1');
    assert.deepEqual(calls[0].executionContext, {
        agentAlias: null,
        agentId: null,
        requestSource: 'ai-image-pipeline'
    });
});

test('executeImagePlan preserves requestIp and governance execution metadata when provided', async () => {
    const calls = [];
    const pluginManager = {
        async processToolCall(toolName, toolArgs, requestIp, executionContext) {
            calls.push({ toolName, toolArgs, requestIp, executionContext });
            return { path: 'A:\\images\\governed.png' };
        }
    };

    const result = await executeImagePlan({
        steps: [{
            type: 'generate_image',
            plugin: 'DoubaoGen',
            prompt: 'governed attribution test'
        }]
    }, {
        pluginManager,
        requestIp: '10.0.0.8',
        executionContext: {
            requestSource: ' ai-image-pipeline ',
            operatorId: ' admin-user ',
            taskId: ' task-123 ',
            invocationId: ' pipe-456 '
        }
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestIp, '10.0.0.8');
    assert.deepEqual(calls[0].executionContext, {
        agentAlias: null,
        agentId: null,
        requestSource: 'ai-image-pipeline',
        operatorId: 'admin-user',
        taskId: 'task-123',
        invocationId: 'pipe-456'
    });
});
