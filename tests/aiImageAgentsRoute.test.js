const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const test = require('node:test');
const express = require('express');
const {
    createNativeImageDelegateRegistry,
    registerSerumBottleSecretlessDoubaoDelegate,
} = require('../modules/nativeImageDelegateRegistry');

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

function createSerumBottleSecretlessBody(overrides = {}) {
    const body = {
        pipeline_id: 'serum-pipe-1',
        task_id: 'AUTH-DRAFT-SECRETLESS-SERUM-OPTION-A-VCPTB-IMPLEMENT-20260602-001',
        route_id: 'serum_bottle_vcptoolbox_route_owner_runtime',
        max_provider_calls: 1,
        max_plugin_calls: 1,
        max_api_calls: 1,
        max_images: 1,
        retry_allowed: false,
        receipt_ref: 'reports/runtime_to_review_v1/serum_bottle_exact_live_probe_receipt_20260601_attempt_004.json',
        artifact_record_ref: 'reports/runtime_to_review_v1/serum_bottle_exact_live_probe_artifact_record_20260601_attempt_004.json',
        plan: {
            steps: [{
                type: 'generate_image',
                plugin: 'DoubaoGen',
                prompt: 'serum bottle test prompt',
                model: 'doubao-seedream-5-0-260128',
                output_directory_ref: 'runs/real_generation/runtime_to_review_v1_guarded_live_probe_serum_bottle_secretless_attempt_007/'
            }]
        },
        ...overrides
    };

    if (!Object.prototype.hasOwnProperty.call(overrides, 'non_secret_payload_hash')) {
        body.non_secret_payload_hash = hashCanonicalPayload(body);
    }

    return body;
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashCanonicalPayload(body) {
    const bodyWithoutHash = { ...body };
    delete bodyWithoutHash.non_secret_payload_hash;
    delete bodyWithoutHash.nonSecretPayloadHash;
    return crypto.createHash('sha256').update(canonicalJson(bodyWithoutHash)).digest('hex');
}

function createSerumBottleSecretlessOptions(overrides = {}) {
    const registry = createNativeImageDelegateRegistry();
    registerSerumBottleSecretlessDoubaoDelegate(
        registry,
        overrides.delegateHandler || (async () => ({
            ok: true,
            result: {
                ok: true,
                imageUrl: 'file:///tmp/serum.png',
                sha256: 'a'.repeat(64),
                mime: 'image/png',
                width: 1024,
                height: 1536,
            },
            provider_contact_performed: true,
            plugin_call_performed: true,
            api_call_performed: true,
            image_generation_performed: true,
        })),
        { enabled: overrides.delegateEnabled !== false }
    );

    return {
        enableAiImageRealExecution: overrides.enableAiImageRealExecution !== false,
        enableNativeDoubaoSecretlessRuntimeDelegate:
            overrides.enableNativeDoubaoSecretlessRuntimeDelegate !== false,
        nativeImageDelegateRegistry: registry,
        async authorizeSerumBottleSecretlessExecution(request) {
            if (typeof overrides.authorizeSerumBottleSecretlessExecution === 'function') {
                return overrides.authorizeSerumBottleSecretlessExecution(request);
            }
            return {
                ok: true,
                operatorId: 'vcptoolbox-internal-serum',
                authorizationId: 'serum-internal-auth-001',
                receiptId: 'serum-internal-receipt-001'
            };
        }
    };
}

test('aiImageAgents execute route allows real execution from trusted admin attribution even without body.operator', async () => {
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
            operator: null
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

test('aiImageAgents serum-bottle secretless helper authorizes internally before stubbed execution', async () => {
    const calls = [];
    const authorizerCalls = [];
    const events = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            events.push('executor');
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution', receiptId: 'stubbed-execution-receipt' };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            ip: '::ffff:10.0.0.21',
            body: createSerumBottleSecretlessBody()
        }, createSerumBottleSecretlessOptions({
            async authorizeSerumBottleSecretlessExecution(request) {
                events.push('authorizer');
                authorizerCalls.push(request);
                return {
                    ok: true,
                    operatorId: 'vcptoolbox-internal-serum',
                    authorizationId: 'serum-internal-auth-001',
                    receiptId: 'serum-internal-receipt-001'
                };
            }
        }));

        assert.equal(result.ok, true);
        assert.deepEqual(events, ['authorizer', 'executor']);
        assert.equal(authorizerCalls.length, 1);
        assert.equal(authorizerCalls[0].routeId, 'serum_bottle_vcptoolbox_route_owner_runtime');
        assert.deepEqual(authorizerCalls[0].budget, {
            maxProviderCalls: 1,
            maxPluginCalls: 1,
            maxApiCalls: 1,
            maxImages: 1,
            retryAllowed: false
        });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].input.requestFlags, {
            execute_pipeline: true,
            confirm_external_effects: true,
            reason: undefined,
            ticket: undefined
        });
        assert.equal(calls[0].options.dryRun, false);
        assert.equal(typeof calls[0].options.pluginManager.processToolCall, 'function');
        assert.equal(typeof calls[0].options.pluginManager.getPlugin, 'undefined');
        assert.deepEqual(calls[0].options.executionContext, {
            requestSource: 'ai-image-pipeline',
            operatorId: 'vcptoolbox-internal-serum',
            taskId: 'AUTH-DRAFT-SECRETLESS-SERUM-OPTION-A-VCPTB-IMPLEMENT-20260602-001',
            invocationId: 'serum-pipe-1',
            routeId: 'serum_bottle_vcptoolbox_route_owner_runtime',
            serumBottleSecretless: true,
            serumBottleSecretlessAuthorizationId: 'serum-internal-auth-001'
        });
        assert.deepEqual(result.result.serumBottleSecretlessAuthorization, {
            authorizationId: 'serum-internal-auth-001',
            receiptId: 'serum-internal-receipt-001'
        });
    });
});

test('aiImageAgents serum-bottle secretless internal router exposes only exact secretless route without Authorization header', async (t) => {
    const calls = [];
    const authorizerCalls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution', receiptId: 'stubbed-execution-receipt' };
        }
    }, async ({ createSerumBottleSecretlessInternalRouter }) => {
        const app = express();
        app.use(express.json());
        app.use('/internal/ai-image-agents', createSerumBottleSecretlessInternalRouter(createSerumBottleSecretlessOptions({
            async authorizeSerumBottleSecretlessExecution(request) {
                authorizerCalls.push(request);
                return {
                    ok: true,
                    operatorId: 'vcptoolbox-internal-serum',
                    authorizationId: 'serum-internal-auth-001',
                    receiptId: 'serum-internal-receipt-001'
                };
            }
        })));

        const server = await new Promise((resolve) => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        t.after(() => new Promise((resolve) => server.close(resolve)));

        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(`${baseUrl}/internal/ai-image-agents/execute/serum-bottle-secretless`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createSerumBottleSecretlessBody())
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(authorizerCalls.length, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.operatorId, 'vcptoolbox-internal-serum');

        const ordinaryExecuteResponse = await fetch(`${baseUrl}/internal/ai-image-agents/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dryRun: false, confirm: true })
        });
        assert.equal(ordinaryExecuteResponse.status, 404);
    });
});

test('aiImageAgents serum-bottle secretless helper fails closed when internal authorizer is missing', async () => {
    const calls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const options = createSerumBottleSecretlessOptions();
        delete options.authorizeSerumBottleSecretlessExecution;

        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, options);

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_internal_authorizer_missing');
        assert.equal(result.result.provider_contact_performed, false);
        assert.equal(result.result.authorization_header_constructed, false);
        assert.equal(calls.length, 0);
    });
});

test('aiImageAgents serum-bottle secretless helper fails closed when native delegate registry is missing', async () => {
    const calls = [];
    const authorizerCalls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, {
            enableAiImageRealExecution: true,
            enableNativeDoubaoSecretlessRuntimeDelegate: true,
            async authorizeSerumBottleSecretlessExecution(request) {
                authorizerCalls.push(request);
                return {
                    ok: true,
                    operatorId: 'vcptoolbox-internal-serum',
                    authorizationId: 'serum-internal-auth-001',
                    receiptId: 'serum-internal-receipt-001'
                };
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_native_delegate_registry_missing');
        assert.equal(result.result.provider_contact_performed, false);
        assert.equal(result.result.authorization_header_constructed, false);
        assert.equal(calls.length, 0);
        assert.equal(authorizerCalls.length, 0);
    });
});

test('aiImageAgents serum-bottle secretless helper rejects budget drift before stubbed execution', async () => {
    const calls = [];
    const authorizerCalls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody({
                max_provider_calls: 2
            })
        }, createSerumBottleSecretlessOptions({
            async authorizeSerumBottleSecretlessExecution(request) {
                authorizerCalls.push(request);
                return { ok: true, authorizationId: 'should-not-run' };
            }
        }));

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_budget_not_exact');
        assert.deepEqual(result.result.budget, {
            maxProviderCalls: 2,
            maxPluginCalls: 1,
            maxApiCalls: 1,
            maxImages: 1,
            retryAllowed: false
        });
        assert.equal(result.result.provider_contact_performed, false);
        assert.equal(calls.length, 0);
        assert.equal(authorizerCalls.length, 0);
    });
});

test('aiImageAgents serum-bottle secretless helper rejects multiple plugin steps before authorization', async () => {
    const calls = [];
    const authorizerCalls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody({
                plan: {
                    steps: [
                        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'first' },
                        { type: 'generate_image', plugin: 'DoubaoGen', prompt: 'second' }
                    ]
                }
            })
        }, createSerumBottleSecretlessOptions({
            async authorizeSerumBottleSecretlessExecution(request) {
                authorizerCalls.push(request);
                return { ok: true, authorizationId: 'should-not-run' };
            }
        }));

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_payload_schema_invalid');
        assert.equal(result.result.reason, 'exactly_one_plan_step_required');
        assert.equal(result.result.provider_contact_performed, false);
        assert.equal(calls.length, 0);
        assert.equal(authorizerCalls.length, 0);
    });
});

test('aiImageAgents serum-bottle secretless helper rejects recursive secret-bearing payload keys', async () => {
    const cases = [
        {
            name: 'context.authorization',
            bodyPatch: { context: { authorization: 'redacted-test-value' } },
            expectedPath: 'body.context.authorization'
        },
        {
            name: 'headers.Authorization',
            bodyPatch: { headers: { Authorization: 'redacted-test-value' } },
            expectedPath: 'body.headers.Authorization'
        },
        {
            name: 'basic_auth',
            bodyPatch: { basic_auth: 'redacted-test-value' },
            expectedPath: 'body.basic_auth'
        },
        {
            name: 'token',
            bodyPatch: { token: 'redacted-test-value' },
            expectedPath: 'body.token'
        },
        {
            name: 'context.auth',
            bodyPatch: { context: { auth: 'redacted-test-value' } },
            expectedPath: 'body.context.auth'
        }
    ];

    for (const item of cases) {
        const calls = [];
        const authorizerCalls = [];

        await withRouteModule({
            async executeAiImagePipelineV2(input, options) {
                calls.push({ input, options });
                return { ok: true, mode: 'real_execution' };
            }
        }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
            const result = await handleSerumBottleSecretlessExecutionRequest({
                body: createSerumBottleSecretlessBody(item.bodyPatch)
            }, createSerumBottleSecretlessOptions({
                async authorizeSerumBottleSecretlessExecution(request) {
                    authorizerCalls.push(request);
                    return { ok: true, authorizationId: 'should-not-run' };
                }
            }));

            assert.equal(result.ok, false, item.name);
            assert.equal(
                result.result.status,
                'serum_bottle_secretless_payload_contains_forbidden_secret_key',
                item.name
            );
            assert.equal(result.result.provider_contact_performed, false, item.name);
            assert.equal(calls.length, 0, item.name);
            assert.equal(authorizerCalls.length, 0, item.name);
            assert.ok(
                result.result.forbiddenPayloadKeys.includes(item.expectedPath),
                `${item.name} should include ${item.expectedPath}`
            );
        });
    }
});

test('aiImageAgents serum-bottle secretless helper fails closed when delegate is disabled', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2() {
            throw new Error('executor_should_not_run');
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, createSerumBottleSecretlessOptions({ delegateEnabled: false }));

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_native_delegate_missing');
        assert.equal(result.result.provider_contact_performed, false);
    });
});

test('aiImageAgents serum-bottle secretless helper requires real execution and delegate flags', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2() {
            throw new Error('executor_should_not_run');
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const realExecutionOff = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, createSerumBottleSecretlessOptions({ enableAiImageRealExecution: false }));

        assert.equal(realExecutionOff.ok, false);
        assert.equal(realExecutionOff.result.status, 'serum_bottle_secretless_real_execution_flag_disabled');

        const delegateFlagOff = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, createSerumBottleSecretlessOptions({ enableNativeDoubaoSecretlessRuntimeDelegate: false }));

        assert.equal(delegateFlagOff.ok, false);
        assert.equal(delegateFlagOff.result.status, 'serum_bottle_secretless_native_delegate_flag_disabled');
    });
});

test('aiImageAgents serum-bottle secretless helper rejects unknown fields and command override', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2() {
            throw new Error('executor_should_not_run');
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const unknownTopLevel = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody({ unexpected_field: 'blocked' })
        }, createSerumBottleSecretlessOptions());

        assert.equal(unknownTopLevel.ok, false);
        assert.equal(unknownTopLevel.result.status, 'serum_bottle_secretless_payload_unknown_fields');
        assert.deepEqual(unknownTopLevel.result.unknownFields, ['body.unexpected_field']);

        const bodyWithCommandOverride = createSerumBottleSecretlessBody();
        bodyWithCommandOverride.plan.steps[0].command = 'edit';
        bodyWithCommandOverride.non_secret_payload_hash = hashCanonicalPayload(bodyWithCommandOverride);

        const commandOverride = await handleSerumBottleSecretlessExecutionRequest({
            body: bodyWithCommandOverride
        }, createSerumBottleSecretlessOptions());

        assert.equal(commandOverride.ok, false);
        assert.equal(commandOverride.result.status, 'serum_bottle_secretless_payload_unknown_fields');
        assert.deepEqual(commandOverride.result.unknownFields, ['body.plan.steps[0].command']);
    });
});

test('aiImageAgents serum-bottle secretless helper rejects non-Doubao plugin and non-allowlisted model', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2() {
            throw new Error('executor_should_not_run');
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const nonDoubao = createSerumBottleSecretlessBody();
        nonDoubao.plan.steps[0].plugin = 'FluxGen';
        nonDoubao.non_secret_payload_hash = hashCanonicalPayload(nonDoubao);

        const nonDoubaoResult = await handleSerumBottleSecretlessExecutionRequest({
            body: nonDoubao
        }, createSerumBottleSecretlessOptions());

        assert.equal(nonDoubaoResult.ok, false);
        assert.equal(nonDoubaoResult.result.status, 'serum_bottle_secretless_plugin_scope_not_authorized');
        assert.deepEqual(nonDoubaoResult.result.requiredPlugins, ['FluxGen']);

        const badModel = createSerumBottleSecretlessBody();
        badModel.plan.steps[0].model = 'not-allowed-model';
        badModel.non_secret_payload_hash = hashCanonicalPayload(badModel);

        const badModelResult = await handleSerumBottleSecretlessExecutionRequest({
            body: badModel
        }, createSerumBottleSecretlessOptions());

        assert.equal(badModelResult.ok, false);
        assert.equal(badModelResult.result.status, 'serum_bottle_secretless_model_not_allowed');
        assert.equal(badModelResult.result.modelId, 'not-allowed-model');
    });
});

test('aiImageAgents serum-bottle secretless helper rejects canonical payload hash mismatch', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2() {
            throw new Error('executor_should_not_run');
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody({
                non_secret_payload_hash: '0'.repeat(64)
            })
        }, createSerumBottleSecretlessOptions());

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'serum_bottle_secretless_non_secret_payload_hash_mismatch');
        assert.match(result.result.expectedPayloadHash, /^[a-f0-9]{64}$/);
        assert.equal(result.result.receivedPayloadHash, '0'.repeat(64));
    });
});

test('aiImageAgents serum-bottle secretless helper records bound delegate and artifact evidence on success', async () => {
    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            await options.pluginManager.processToolCall(
                'DoubaoGen',
                { command: 'generate', prompt: input.plan.steps[0].prompt, model: input.plan.steps[0].model },
                '127.0.0.1',
                options.executionContext
            );
            return {
                ok: true,
                mode: 'real_execution',
                images: [{
                    plugin: 'DoubaoGen',
                    sha256: 'b'.repeat(64),
                    mime: 'image/png',
                    dimensions: { width: 1024, height: 1536 },
                }],
            };
        }
    }, async ({ handleSerumBottleSecretlessExecutionRequest }) => {
        const result = await handleSerumBottleSecretlessExecutionRequest({
            body: createSerumBottleSecretlessBody()
        }, createSerumBottleSecretlessOptions());

        assert.equal(result.ok, true);
        assert.deepEqual(result.result.serumBottleSecretlessRuntimeEvidence, {
            routeId: 'serum_bottle_vcptoolbox_route_owner_runtime',
            delegateId: 'serum_bottle_secretless_doubao_v1',
            providerId: 'doubao',
            pluginId: 'DoubaoGen',
            apiId: 'generate_image',
            internalCommand: 'generate',
            providerCalls: 1,
            pluginCalls: 1,
            apiCalls: 1,
            images: 1,
            artifact: {
                sha256: 'b'.repeat(64),
                mime: 'image/png',
                dimensions: { width: 1024, height: 1536 },
            },
        });
    });
});

test('aiImageAgents execute route stays dry-run when no trusted or fallback operator is available', async () => {
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
                confirm: true,
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
            taskId: 'task-2',
            invocationId: 'pipe-2'
        });
    });
});

test('aiImageAgents execute route can still use body.operator as a fallback outside admin middleware', async () => {
    const calls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = { processToolCall() {} };
        await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.7',
            body: {
                pipelineId: 'pipe-3',
                taskId: 'task-3',
                dryRun: false,
                confirm: true,
                operator: 'manual-operator',
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'fallback test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.dryRun, false);
        assert.equal(calls[0].options.pluginManager, pluginManager);
        assert.deepEqual(calls[0].options.executionContext, {
            requestSource: 'ai-image-pipeline',
            operatorId: 'manual-operator',
            taskId: 'task-3',
            invocationId: 'pipe-3'
        });
    });
});

test('aiImageAgents execute route loads missing DoubaoGen before real execution', async () => {
    const calls = [];
    let loaded = false;
    let loadCount = 0;

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return loaded && name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            async loadPlugins() {
                loadCount += 1;
                loaded = true;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.8',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-4',
                taskId: 'task-4',
                dryRun: false,
                confirm: true,
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(loadCount, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.pluginManager, pluginManager);
    });
});

test('aiImageAgents execute route fails closed when required plugin remains missing after load', async () => {
    const calls = [];
    let loadCount = 0;

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin() {
                return null;
            },
            async loadPlugins() {
                loadCount += 1;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.9',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-5',
                taskId: 'task-5',
                dryRun: false,
                confirm: true,
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'plugin_not_registered');
        assert.deepEqual(result.result.missingPlugins, ['DoubaoGen']);
        assert.equal(result.result.pluginLoadAttempted, true);
        assert.equal(loadCount, 1);
        assert.equal(calls.length, 0);
    });
});

test('aiImageAgents execute route forwards exact retry 003 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_003';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.10',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-6',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-003',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route forwards exact retry 004 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_004';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.12',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-8',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-004',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route forwards exact retry 005 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_005';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.13',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-9',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-005',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route forwards exact retry 006 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_006';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.14',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-10',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-006',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route forwards exact retry 007 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\v0_6_73_real_vcp_agent_generation_retry_007';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.15',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-11',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260527-007',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route forwards exact runtime-to-review v1 Doubao project base path override', async () => {
    const calls = [];
    const exactOutputRoot = 'A:\\agent-image-lab\\agent-image-lab-v0.2\\runs\\real_generation\\runtime_to_review_v1_guarded_live_probe';

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.16',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-runtime-v1',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-RUNTIME-TO-REVIEW-V1-20260529-001',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: exactOutputRoot
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.executionContext.doubaoProjectBasePathOverride, exactOutputRoot);
    });
});

test('aiImageAgents execute route rejects unapproved Doubao project base path override', async () => {
    const calls = [];

    await withRouteModule({
        async executeAiImagePipelineV2(input, options) {
            calls.push({ input, options });
            return { ok: true, mode: 'real_execution' };
        }
    }, async ({ handleAiImagePipelineRequest }) => {
        const pluginManager = {
            getPlugin(name) {
                return name === 'DoubaoGen' ? { name: 'DoubaoGen' } : null;
            },
            processToolCall() {}
        };

        const result = await handleAiImagePipelineRequest({
            ip: '::ffff:10.0.0.11',
            adminAuthUser: 'admin-root',
            body: {
                pipelineId: 'pipe-7',
                taskId: 'AUTH-DRAFT-NATIVE-DOUBAO-SEEDREAM5-RETRY-20260526-003',
                dryRun: false,
                confirm: true,
                context: {
                    doubaoProjectBasePathOverride: 'A:\\VCP\\apps\\VCPToolBox'
                },
                plan: {
                    steps: [{ type: 'generate_image', plugin: 'DoubaoGen', prompt: 'test' }]
                }
            }
        }, {
            pluginManager
        });

        assert.equal(result.ok, false);
        assert.equal(result.result.status, 'project_base_path_override_not_authorized');
        assert.equal(result.result.error, 'doubao_project_base_path_override_path_not_authorized');
        assert.equal(calls.length, 0);
    });
});
