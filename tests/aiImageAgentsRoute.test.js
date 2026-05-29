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
