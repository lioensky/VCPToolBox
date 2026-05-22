const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pluginManager = require('../Plugin.js');
const ChatCompletionHandler = require('../modules/chatCompletionHandler.js');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

test('ChatCompletionHandler should keep configured agent context authoritative', () => {
    const configuredContext = ChatCompletionHandler._buildExecutionContext(
        { expandedAgentName: 'Nova' },
        {
            agentAlias: 'Codex',
            agentId: 'codex-desktop',
            requestSource: 'trusted-route'
        }
    );

    assert.deepEqual(configuredContext, {
        agentAlias: 'Codex',
        agentId: 'codex-desktop',
        requestSource: 'trusted-route'
    });

    const expandedContext = ChatCompletionHandler._buildExecutionContext(
        { expandedAgentName: 'Nova' },
        null
    );

    assert.deepEqual(expandedContext, {
        agentAlias: 'Nova',
        agentId: null,
        requestSource: 'chatCompletionHandler'
    });
});

test('ToolExecutor should pass executionContext through PluginManager into CodexMemoryBridge', async () => {
    const previousProjectBasePath = pluginManager.projectBasePath;
    const previousPlugin = pluginManager.plugins.get('CodexMemoryBridge');
    const previousShouldApprove = pluginManager.toolApprovalManager?.shouldApprove;
    const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-e2e-test-'));
    const pluginBasePath = path.resolve(__dirname, '..', 'Plugin', 'CodexMemoryBridge');

    try {
        pluginManager.setProjectBasePath(tempBasePath);
        if (pluginManager.toolApprovalManager) {
            pluginManager.toolApprovalManager.config.enabled = false;
            pluginManager.toolApprovalManager.shouldApprove = () => false;
        }

        pluginManager.plugins.set('CodexMemoryBridge', {
            name: 'CodexMemoryBridge',
            pluginType: 'synchronous',
            communication: { protocol: 'stdio', timeout: 10000 },
            entryPoint: { command: 'node codex-memory-bridge.js' },
            basePath: pluginBasePath,
            requiresAdmin: false,
            configSchema: {}
        });

        const toolExecutor = new ToolExecutor({
            pluginManager,
            webSocketServer: { broadcast() {} },
            debugMode: false,
            vcpToolCode: null,
            getRealAuthCode: async () => null
        });

        const toolCall = {
            name: 'CodexMemoryBridge',
            args: {
                target: 'process',
                title: 'tool-executor chain test',
                content: 'Type: checkpoint\nverify tool executor chain',
                evidence: 'e2e test evidence',
                validated: true,
                reusable: false,
                tags: 'test, e2e',
                sensitivity: 'none'
            }
        };

        const noContextResult = await toolExecutor.execute(toolCall, null, [], null);
        assert.equal(noContextResult.raw.decision, 'rejected');
        assert.match(noContextResult.raw.reason, /Codex agent context|Codex Agent/i);

        const withContextResult = await toolExecutor.execute(toolCall, null, [], {
            agentAlias: 'Codex',
            agentId: 'tool-executor-test',
            requestSource: 'node-test'
        });

        assert.equal(withContextResult.raw.decision, 'accepted');
        assert.equal(withContextResult.raw.agentAlias, 'Codex');
        assert.equal(withContextResult.raw.requestSource, 'node-test');
        assert.match(withContextResult.raw.memoryId, /^codex-process-/);
        assert.ok(withContextResult.raw.filePath, 'accepted result should include filePath');
        await fs.access(withContextResult.raw.filePath);
    } finally {
        if (previousPlugin) {
            pluginManager.plugins.set('CodexMemoryBridge', previousPlugin);
        } else {
            pluginManager.plugins.delete('CodexMemoryBridge');
        }
        if (pluginManager.toolApprovalManager && previousShouldApprove) {
            pluginManager.toolApprovalManager.shouldApprove = previousShouldApprove;
        }
        pluginManager.setProjectBasePath(previousProjectBasePath || null);
        await fs.rm(tempBasePath, { recursive: true, force: true });
    }
});

test('Codex memory policy should allow dream diaries and block normal direct DailyNote writes', () => {
    const toolExecutor = new ToolExecutor({
        pluginManager: {},
        webSocketServer: { broadcast() {} },
        debugMode: false,
        vcpToolCode: null,
        getRealAuthCode: async () => null
    });

    const dreamAllowed = toolExecutor._enforceCodexMemoryPolicy(
        'DailyNoteWrite',
        { maid: '[Codex的梦]Codex' },
        { agentAlias: 'Codex' }
    );
    assert.equal(dreamAllowed.allowed, true);

    const normalBlocked = toolExecutor._enforceCodexMemoryPolicy(
        'DailyNoteWrite',
        { maid: '[Codex]Codex' },
        { agentAlias: 'Codex' }
    );
    assert.equal(normalBlocked.allowed, false);
    assert.match(normalBlocked.message, /CodexMemoryBridge\.record/);

    const nonCodexAllowed = toolExecutor._enforceCodexMemoryPolicy(
        'DailyNoteWrite',
        { maid: '[Codex]Codex' },
        { agentAlias: 'Nova' }
    );
    assert.equal(nonCodexAllowed.allowed, true);
});

test('ToolExecutor should block direct DailyNote writes for Codex ordinary memory', async () => {
    const toolExecutor = new ToolExecutor({
        pluginManager: {
            getPlugin() {
                return null;
            }
        },
        webSocketServer: { broadcast() {} },
        debugMode: false,
        vcpToolCode: false,
        getRealAuthCode: async () => null
    });

    const result = await toolExecutor.execute(
        {
            name: 'DailyNote',
            args: {
                command: 'create',
                maid: '[Codex]Codex',
                Date: '2026-04-11',
                Content: 'Type: checkpoint\nThis direct write should be blocked.\nTag: runtime, block-test'
            }
        },
        '127.0.0.1',
        [],
        {
            agentAlias: 'Codex',
            agentId: 'test-agent',
            requestSource: 'vcpchat'
        }
    );

    assert.equal(result.success, false);
    assert.match(result.error, /CodexMemoryBridge\.record/);
    assert.match(result.content[0].text, /CodexMemoryBridge\.record/);
});
