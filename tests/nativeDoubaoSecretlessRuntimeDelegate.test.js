const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createNativeDoubaoSecretlessRuntimeDelegate,
} = require('../modules/nativeDoubaoSecretlessRuntimeDelegate');

test('NativeDoubao delegate preserves explicit DoubaoGen model in tool args', async () => {
    const calls = [];
    const delegate = createNativeDoubaoSecretlessRuntimeDelegate({
        enabled: true,
        pluginManager: {
            async processToolCall(toolName, toolArgs, requestIp, executionContext) {
                calls.push({ toolName, toolArgs, requestIp, executionContext });
                return {
                    details: {
                        imageUrls: ['https://example.test/generated.png'],
                        model: toolArgs.model,
                    },
                };
            },
        },
    });

    const result = await delegate({
        toolName: 'DoubaoGen',
        toolArgs: {
            command: 'generate',
            prompt: 'seedream 5 passthrough',
            model: 'doubao-seedream-5-0-260128',
            resolution: '720x1280',
        },
        requestIp: '127.0.0.1',
        executionContext: {
            requestSource: 'ai-image-pipeline',
            taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-003',
        },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toolName, 'DoubaoGen');
    assert.equal(calls[0].toolArgs.model, 'doubao-seedream-5-0-260128');
    assert.equal(calls[0].toolArgs.command, 'generate');
    assert.equal(calls[0].executionContext.requestSource, 'agent-image-lab-secretless-runtime');
    assert.equal(calls[0].executionContext.providerBindingRefRedacted, true);
});
