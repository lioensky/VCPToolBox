const assert = require('node:assert/strict');
const { test } = require('node:test');

const embeddingUtilsPath = require.resolve('../EmbeddingUtils');
require.cache[embeddingUtilsPath] = {
    id: embeddingUtilsPath,
    filename: embeddingUtilsPath,
    loaded: true,
    exports: {
        getEmbeddingsBatch: async () => {
            throw new Error('EmbeddingUtils stub should not be called by this test');
        },
        cosineSimilarity: () => 0
    }
};

const ToolExecutor = require('../modules/vcpLoop/toolExecutor');

function createToolExecutor(calls) {
    return new ToolExecutor({
        pluginManager: {
            getPlugin(toolName) {
                return toolName === 'NoopTool'
                    ? { name: 'NoopTool' }
                    : null;
            },
            async processToolCall(toolName, toolArgs, requestIp, executionContext) {
                calls.push({ toolName, toolArgs, requestIp, executionContext });
                return { ok: true, executionContext };
            }
        },
        webSocketServer: { broadcast() {} },
        debugMode: false,
        vcpToolCode: null,
        getRealAuthCode: async () => null
    });
}

test('ToolExecutor carries optional execution context metadata into processToolCall', async () => {
    const calls = [];
    const toolExecutor = createToolExecutor(calls);

    const result = await toolExecutor.execute(
        {
            name: 'NoopTool',
            args: { value: 'context smoke test' }
        },
        '127.0.0.1',
        [],
        {
            agentAlias: 'Codex',
            agentId: 'tool-executor-test',
            requestSource: 'node-test',
            operatorId: 'operator-1',
            bridgeId: 'bridge-main',
            taskId: 'task-123',
            invocationId: 'invocation-abc'
        }
    );

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].executionContext, {
        agentAlias: 'Codex',
        agentId: 'tool-executor-test',
        requestSource: 'node-test',
        operatorId: 'operator-1',
        bridgeId: 'bridge-main',
        taskId: 'task-123',
        invocationId: 'invocation-abc'
    });
    assert.deepEqual(result.raw.executionContext, calls[0].executionContext);
});

test('ToolExecutor keeps existing default execution context behavior', async () => {
    const calls = [];
    const toolExecutor = createToolExecutor(calls);

    await toolExecutor.execute(
        {
            name: 'NoopTool',
            args: {}
        },
        null,
        [],
        null
    );

    assert.deepEqual(calls[0].executionContext, {
        agentAlias: null,
        agentId: null,
        requestSource: 'unknown'
    });
});
