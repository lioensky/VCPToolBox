const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pluginManager = require('../Plugin.js');

after(() => {
    if (pluginManager.toolApprovalManager && typeof pluginManager.toolApprovalManager.shutdown === 'function') {
        pluginManager.toolApprovalManager.shutdown();
    }
});

function createBridgeArgs(overrides = {}) {
    return {
        target: 'process',
        title: 'test checkpoint',
        content: 'Type: checkpoint\nverify context bridge',
        evidence: 'automated test evidence',
        validated: true,
        reusable: false,
        tags: 'test, codex-memory-bridge',
        sensitivity: 'none',
        ...overrides
    };
}

async function withCodexMemoryBridge(run) {
    const previousProjectBasePath = pluginManager.projectBasePath;
    const previousPlugin = pluginManager.plugins.get('CodexMemoryBridge');
    const previousApprovalEnabled = pluginManager.toolApprovalManager?.config?.enabled;
    const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-bridge-test-'));
    const pluginBasePath = path.resolve(__dirname, '..', 'Plugin', 'CodexMemoryBridge');

    try {
        pluginManager.setProjectBasePath(tempBasePath);
        if (pluginManager.toolApprovalManager && pluginManager.toolApprovalManager.config) {
            pluginManager.toolApprovalManager.config.enabled = false;
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

        await run({ tempBasePath });
    } finally {
        if (previousPlugin) {
            pluginManager.plugins.set('CodexMemoryBridge', previousPlugin);
        } else {
            pluginManager.plugins.delete('CodexMemoryBridge');
        }
        if (pluginManager.toolApprovalManager?.config && previousApprovalEnabled !== undefined) {
            pluginManager.toolApprovalManager.config.enabled = previousApprovalEnabled;
        }
        pluginManager.setProjectBasePath(previousProjectBasePath || null);
        await fs.rm(tempBasePath, { recursive: true, force: true });
    }
}

test('CodexMemoryBridge should reject without context and accept with Codex context', async () => {
    await withCodexMemoryBridge(async ({ tempBasePath }) => {
        const args = createBridgeArgs();

        const rejected = await pluginManager.processToolCall('CodexMemoryBridge', args, null, null);
        assert.equal(rejected.decision, 'rejected');
        assert.match(rejected.reason, /Codex agent context|Codex Agent/i);

        const accepted = await pluginManager.processToolCall('CodexMemoryBridge', args, null, {
            agentAlias: 'Codex',
            agentId: 'test-agent',
            requestSource: 'node-test'
        });
        assert.equal(accepted.decision, 'accepted');
        assert.equal(accepted.agentAlias, 'Codex');
        assert.equal(accepted.requestSource, 'node-test');
        assert.match(accepted.memoryId, /^codex-process-/);
        assert.ok(accepted.filePath, 'accepted response should include filePath');
        assert.match(accepted.filePath, /dailynote[\\/]Codex[\\/]/);
        await fs.access(accepted.filePath);
        const writtenContent = await fs.readFile(accepted.filePath, 'utf8');
        assert.match(writtenContent, new RegExp(`Memory-ID: ${accepted.memoryId}`));

        const auditLogPath = path.join(tempBasePath, 'logs', 'codex-memory-bridge.jsonl');
        const auditRaw = await fs.readFile(auditLogPath, 'utf8');
        const auditEntries = auditRaw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));

        assert.ok(auditEntries.some(entry => entry.decision === 'rejected'));
        assert.ok(auditEntries.some(entry =>
            entry.decision === 'accepted' &&
            entry.agentAlias === 'Codex' &&
            entry.memoryId === accepted.memoryId &&
            entry.title === 'test checkpoint'
        ));
    });
});

test('CodexMemoryBridge should accept validated reusable knowledge records', async () => {
    await withCodexMemoryBridge(async () => {
        const accepted = await pluginManager.processToolCall('CodexMemoryBridge', createBridgeArgs({
            target: 'knowledge',
            title: 'Rule: relative knowledge base paths resolve from toolbox root',
            content: 'Relative KNOWLEDGEBASE_ROOT_PATH values resolve from the VCPToolBox root.',
            evidence: 'Regression test captured the corrected writer-core behavior.',
            validated: true,
            reusable: true,
            tags: 'architecture, path-resolution'
        }), null, {
            agentAlias: 'Codex',
            agentId: 'test-agent',
            requestSource: 'node-test'
        });

        assert.equal(accepted.decision, 'accepted');
        assert.equal(accepted.agentAlias, 'Codex');
        assert.equal(accepted.targetDiary, 'Codex knowledge');
        assert.equal(accepted.reason, 'written to Codex knowledge.');
        assert.match(accepted.memoryId, /^codex-knowledge-/);
        assert.ok(accepted.filePath, 'accepted response should include filePath');
        assert.match(accepted.filePath, /dailynote[\\/]Codex的知识[\\/]/);
        await fs.access(accepted.filePath);

        const writtenContent = await fs.readFile(accepted.filePath, 'utf8');
        assert.match(writtenContent, /Rule: relative knowledge base paths resolve from toolbox root/);
        assert.match(writtenContent, /Relative KNOWLEDGEBASE_ROOT_PATH values resolve from the VCPToolBox root\./);
        assert.match(writtenContent, /Regression test captured the corrected writer-core behavior\./);
        assert.match(writtenContent, /Tag: architecture, path-resolution/);
    });
});

test('CodexMemoryBridge should reject sensitive knowledge writes and record both audit decisions', async () => {
    await withCodexMemoryBridge(async ({ tempBasePath }) => {
        const executionContext = {
            agentAlias: 'Codex',
            agentId: 'test-agent',
            requestSource: 'node-test'
        };

        const accepted = await pluginManager.processToolCall('CodexMemoryBridge', createBridgeArgs({
            title: 'Checkpoint for audit coverage',
            content: 'Type: checkpoint\nThis creates an accepted entry for audit coverage.',
            evidence: 'Accepted-path audit setup.',
            tags: 'audit, setup'
        }), null, executionContext);
        assert.equal(accepted.decision, 'accepted');

        const rejected = await pluginManager.processToolCall('CodexMemoryBridge', createBridgeArgs({
            target: 'knowledge',
            title: 'Secret should be rejected',
            content: 'Validation payload.',
            evidence: 'Rejected-path audit setup.',
            validated: true,
            reusable: true,
            sensitivity: 'secret',
            tags: 'rejection-test'
        }), null, executionContext);

        assert.equal(rejected.decision, 'rejected');
        assert.equal(rejected.filePath, null);
        assert.match(rejected.reason, /敏感|sensitive|sensitivity=none/i);

        const auditLogPath = path.join(tempBasePath, 'logs', 'codex-memory-bridge.jsonl');
        const auditRaw = await fs.readFile(auditLogPath, 'utf8');
        const auditEntries = auditRaw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));

        assert.ok(auditEntries.some(entry => entry.decision === 'accepted' && entry.target === 'process'));
        assert.ok(auditEntries.some(entry => entry.decision === 'rejected' && entry.target === 'knowledge'));
    });
});

test('CodexMemoryBridge should allow non-high-risk process sensitivities and still reject secret process writes', async () => {
    await withCodexMemoryBridge(async () => {
        const executionContext = {
            agentAlias: 'Codex',
            agentId: 'test-agent',
            requestSource: 'node-test'
        };

        const accepted = await pluginManager.processToolCall('CodexMemoryBridge', createBridgeArgs({
            title: 'Process note with personal sensitivity',
            content: 'Type: checkpoint\nThis process checkpoint is marked personal but not secret.',
            evidence: 'Allowed process-sensitivity regression test.',
            sensitivity: 'personal',
            tags: 'process, sensitivity'
        }), null, executionContext);

        assert.equal(accepted.decision, 'accepted');
        assert.match(accepted.memoryId, /^codex-process-/);

        const rejected = await pluginManager.processToolCall('CodexMemoryBridge', createBridgeArgs({
            title: 'Secret process note',
            content: 'Type: checkpoint\nThis process checkpoint includes secret material.',
            evidence: 'Rejected process-sensitivity regression test.',
            sensitivity: 'secret',
            tags: 'process, secret'
        }), null, executionContext);

        assert.equal(rejected.decision, 'rejected');
        assert.match(rejected.reason, /高风险敏感|敏感|sensitive/i);
    });
});
