const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    buildApprovalArgsPreview,
    buildToolApprovalEvidence,
    isSensitiveArgKey
} = require('../modules/toolApprovalEvidence');

test('buildToolApprovalEvidence carries resolved identity and normalized context', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'PowerShellExecutor',
        approvalDecision: {
            requiresApproval: true,
            notifyAiOnReject: false,
            matchedRule: 'ServerPowerShellExecutor:Get-ChildItem',
            matchedCommand: 'Get-ChildItem',
            requestedToolName: 'PowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor',
            wasAlias: true
        },
        executionContext: {
            agentAlias: ' Codex ',
            agentId: ' codex-desktop ',
            requestSource: ' human-tool-route '
        }
    });

    assert.deepEqual(evidence, {
        requestedToolName: 'PowerShellExecutor',
        canonicalToolName: 'ServerPowerShellExecutor',
        matchedRule: 'ServerPowerShellExecutor:Get-ChildItem',
        matchedCommand: 'Get-ChildItem',
        wasAlias: true,
        requestSource: 'human-tool-route',
        agentAlias: 'Codex',
        agentId: 'codex-desktop',
        requiresApproval: true,
        notifyAiOnReject: false,
        effect: {
            requestedToolName: 'PowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor',
            command: null,
            effectClass: 'execute_shell',
            effectConfidence: 'explicit',
            effectReasons: ['shell execution surface remains powerful even for read-like commands'],
            effectEvidenceSources: ['tool_default:ServerPowerShellExecutor']
        }
    });
});

test('buildToolApprovalEvidence defaults missing context conservatively', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'SciCalculator',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'SciCalculator'
        }
    });

    assert.equal(evidence.requestedToolName, 'SciCalculator');
    assert.equal(evidence.canonicalToolName, 'SciCalculator');
    assert.equal(evidence.requestSource, 'unknown');
    assert.equal(evidence.agentAlias, null);
    assert.equal(evidence.agentId, null);
    assert.equal(evidence.notifyAiOnReject, true);
    assert.equal(evidence.effect.effectClass, 'unknown');
    assert.equal(evidence.effect.effectConfidence, 'unknown');
});

test('buildToolApprovalEvidence carries optional execution metadata', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'ServerPowerShellExecutor',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerPowerShellExecutor',
            requestedToolName: 'ServerPowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor'
        },
        executionContext: {
            requestSource: 'task-scheduler',
            operatorId: 'operator-1',
            bridgeId: 'bridge-main',
            taskId: 'task-123',
            invocationId: 'invocation-abc'
        }
    });

    assert.equal(evidence.requestSource, 'task-scheduler');
    assert.equal(evidence.operatorId, 'operator-1');
    assert.equal(evidence.bridgeId, 'bridge-main');
    assert.equal(evidence.taskId, 'task-123');
    assert.equal(evidence.invocationId, 'invocation-abc');
    assert.equal(evidence.effect.effectClass, 'execute_shell');
});

test('buildToolApprovalEvidence does not carry raw args or secret-like values', () => {
    const toolArgs = {
        command: 'Get-ChildItem',
        targetPath: 'C:\\safe',
        tool_password: 'SECRET_VALUE_SHOULD_NOT_APPEAR',
        nested: {
            apiKey: 'NESTED_SECRET_VALUE_SHOULD_NOT_APPEAR',
            harmless: 'visible'
        },
        entries: [
            {
                access_token: 'ARRAY_SECRET_VALUE_SHOULD_NOT_APPEAR',
                name: 'visible-entry'
            }
        ]
    };
    const evidence = buildToolApprovalEvidence({
        toolName: 'ServerPowerShellExecutor',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerPowerShellExecutor',
            requestedToolName: 'ServerPowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor'
        },
        executionContext: {
            requestSource: 'task-scheduler'
        },
        toolArgs
    });

    assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'args'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'toolArgs'), false);
    assert.deepEqual(evidence.effect, {
        requestedToolName: 'ServerPowerShellExecutor',
        canonicalToolName: 'ServerPowerShellExecutor',
        command: 'Get-ChildItem',
        effectClass: 'execute_shell',
        effectConfidence: 'explicit',
        effectReasons: ['shell execution surface remains powerful even for read-like commands'],
        effectEvidenceSources: ['tool_default:ServerPowerShellExecutor']
    });
    assert.deepEqual(evidence.argsPreview, {
        argumentType: 'object',
        argKeys: [
            'command',
            'targetPath',
            'tool_password',
            'nested',
            'nested.apiKey',
            'nested.harmless',
            'entries',
            'entries[].access_token',
            'entries[].name'
        ],
        redactedArgKeys: [
            'tool_password',
            'nested.apiKey',
            'entries[].access_token'
        ],
        containsSensitiveKeys: true,
        hasCommand: true,
        hasCircular: false,
        truncated: false
    });
    assert.equal(JSON.stringify(evidence).includes('SECRET_VALUE_SHOULD_NOT_APPEAR'), false);
    assert.equal(JSON.stringify(evidence).includes('C:\\safe'), false);
    assert.equal(JSON.stringify(evidence).includes('visible-entry'), false);
    assert.equal(toolArgs.tool_password, 'SECRET_VALUE_SHOULD_NOT_APPEAR');
    assert.equal(toolArgs.nested.apiKey, 'NESTED_SECRET_VALUE_SHOULD_NOT_APPEAR');
});

test('buildToolApprovalEvidence classifies FileOperator deletes conservatively', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'FileOperator',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerFileOperator:DeleteFile',
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator',
            wasAlias: true
        },
        executionContext: {
            requestSource: 'human-tool-route'
        },
        toolArgs: {
            command: 'DeleteFile',
            path: 'C:\\safe.txt'
        }
    });

    assert.deepEqual(evidence.effect, {
        requestedToolName: 'FileOperator',
        canonicalToolName: 'ServerFileOperator',
        command: 'DeleteFile',
        effectClass: 'delete_or_destructive',
        effectConfidence: 'explicit',
        effectReasons: ['explicit command override for destructive file delete'],
        effectEvidenceSources: ['command_override:ServerFileOperator:DeleteFile']
    });
    assert.equal(JSON.stringify(evidence).includes('C:\\safe.txt'), false);
});

test('buildToolApprovalEvidence classifies numbered batch commands conservatively', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'FileOperator',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerFileOperator:DeleteFile',
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator',
            wasAlias: true
        },
        executionContext: {
            requestSource: 'task-scheduler'
        },
        toolArgs: {
            command1: 'ReadFile',
            command2: 'DeleteFile',
            path: 'C:\\safe.txt'
        }
    });

    assert.deepEqual(evidence.effect, {
        requestedToolName: 'FileOperator',
        canonicalToolName: 'ServerFileOperator',
        command: 'DeleteFile',
        effectClass: 'delete_or_destructive',
        effectConfidence: 'explicit',
        effectReasons: ['explicit command override for destructive file delete'],
        effectEvidenceSources: ['command_override:ServerFileOperator:DeleteFile']
    });
    assert.equal(JSON.stringify(evidence).includes('C:\\safe.txt'), false);
});

test('buildToolApprovalEvidence classifies WebReadFile as write_local without leaking URL values', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'FileOperator',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerFileOperator:WebReadFile',
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator',
            wasAlias: true
        },
        executionContext: {
            requestSource: 'human-tool-route'
        },
        toolArgs: {
            command: 'WebReadFile',
            url: 'https://example.com/private/report.pdf'
        }
    });

    assert.deepEqual(evidence.effect, {
        requestedToolName: 'FileOperator',
        canonicalToolName: 'ServerFileOperator',
        command: 'WebReadFile',
        effectClass: 'write_local',
        effectConfidence: 'explicit',
        effectReasons: ['explicit command override for network-backed fetch that persists content onto local disk'],
        effectEvidenceSources: ['command_override:ServerFileOperator:WebReadFile']
    });
    assert.equal(JSON.stringify(evidence).includes('https://example.com/private/report.pdf'), false);
});

test('buildToolApprovalEvidence preserves explicit effect mapping for UpdateHistory without leaking payload text', () => {
    const evidence = buildToolApprovalEvidence({
        toolName: 'FileOperator',
        approvalDecision: {
            requiresApproval: true,
            matchedRule: 'ServerFileOperator:UpdateHistory',
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator',
            wasAlias: true
        },
        executionContext: {
            requestSource: 'task-scheduler'
        },
        toolArgs: {
            command: 'UpdateHistory',
            filePath: 'C:\\history.json',
            searchString: 'OLD_ASSISTANT_TEXT_SHOULD_NOT_APPEAR',
            replaceString: 'NEW_ASSISTANT_TEXT_SHOULD_NOT_APPEAR'
        }
    });

    assert.deepEqual(evidence.effect, {
        requestedToolName: 'FileOperator',
        canonicalToolName: 'ServerFileOperator',
        command: 'UpdateHistory',
        effectClass: 'write_local',
        effectConfidence: 'explicit',
        effectReasons: ['explicit command override for local chat history mutation'],
        effectEvidenceSources: ['command_override:ServerFileOperator:UpdateHistory']
    });
    assert.equal(JSON.stringify(evidence).includes('OLD_ASSISTANT_TEXT_SHOULD_NOT_APPEAR'), false);
    assert.equal(JSON.stringify(evidence).includes('NEW_ASSISTANT_TEXT_SHOULD_NOT_APPEAR'), false);
    assert.equal(JSON.stringify(evidence).includes('C:\\history.json'), false);
});

test('buildApprovalArgsPreview summarizes arg shape without mutating input', () => {
    const args = {
        command: 'DeleteFile',
        path: 'tmp.txt',
        options: {
            clientSecret: 'CLIENT_SECRET_VALUE_SHOULD_NOT_APPEAR'
        }
    };

    const preview = buildApprovalArgsPreview(args);

    assert.deepEqual(preview, {
        argumentType: 'object',
        argKeys: [
            'command',
            'path',
            'options',
            'options.clientSecret'
        ],
        redactedArgKeys: [
            'options.clientSecret'
        ],
        containsSensitiveKeys: true,
        hasCommand: true,
        hasCircular: false,
        truncated: false
    });
    assert.equal(args.options.clientSecret, 'CLIENT_SECRET_VALUE_SHOULD_NOT_APPEAR');
    assert.equal(JSON.stringify(preview).includes('DeleteFile'), false);
    assert.equal(JSON.stringify(preview).includes('tmp.txt'), false);
    assert.equal(JSON.stringify(preview).includes('CLIENT_SECRET_VALUE_SHOULD_NOT_APPEAR'), false);
});

test('buildApprovalArgsPreview handles circular values safely', () => {
    const args = {
        command: 'Get-ChildItem'
    };
    args.self = args;
    args.items = [];
    args.items.push(args.items);

    const preview = buildApprovalArgsPreview(args);

    assert.deepEqual(preview, {
        argumentType: 'object',
        argKeys: [
            'command',
            'self',
            'items'
        ],
        redactedArgKeys: [],
        containsSensitiveKeys: false,
        hasCommand: true,
        hasCircular: true,
        truncated: false
    });
});

test('buildApprovalArgsPreview keeps scanning sibling keys after truncating arrays', () => {
    const args = {
        rows: [
            { name: 'a' },
            { name: 'b' },
            { name: 'c' },
            { name: 'd' },
            { name: 'e' },
            { name: 'f' }
        ],
        password: 'SECRET_VALUE_SHOULD_NOT_APPEAR'
    };

    const preview = buildApprovalArgsPreview(args);

    assert.equal(preview.truncated, true);
    assert.equal(preview.containsSensitiveKeys, true);
    assert.deepEqual(preview.redactedArgKeys, ['password']);
    assert.equal(JSON.stringify(preview).includes('SECRET_VALUE_SHOULD_NOT_APPEAR'), false);
});

test('isSensitiveArgKey detects common secret-like arg keys', () => {
    assert.equal(isSensitiveArgKey('api_key'), true);
    assert.equal(isSensitiveArgKey('access_token'), true);
    assert.equal(isSensitiveArgKey('clientSecret'), true);
    assert.equal(isSensitiveArgKey('targetPath'), false);
});

test('PluginManager approval request attaches approvalEvidence without removing args compatibility field', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'Plugin.js'), 'utf8');

    assert.match(source, /buildToolApprovalEvidence/);
    assert.match(source, /const approvalEvidence = buildToolApprovalEvidence/);
    assert.match(source, /toolArgs: pluginSpecificArgs/);
    assert.match(source, /approvalEvidence,/);
    assert.match(source, /args: pluginSpecificArgs/);
});
