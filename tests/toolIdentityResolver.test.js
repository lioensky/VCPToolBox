const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveToolIdentity
} = require('../modules/toolIdentityResolver');

test('ToolIdentityResolver resolves Patch 1A aliases and canonical names', () => {
    const cases = [
        ['PowerShellExecutor', 'ServerPowerShellExecutor', 'alias', true],
        ['ServerPowerShellExecutor', 'ServerPowerShellExecutor', 'exact', false],
        ['FileOperator', 'ServerFileOperator', 'alias', true],
        ['ServerFileOperator', 'ServerFileOperator', 'exact', false],
        ['LocalSearchController', 'ServerSearchController', 'alias', true],
        ['VCPEverything', 'ServerSearchController', 'alias', true],
        ['ServerSearchController', 'ServerSearchController', 'exact', false],
        ['CodeSearcher', 'ServerCodeSearcher', 'alias', true],
        ['ServerCodeSearcher', 'ServerCodeSearcher', 'exact', false],
        ['UnknownTool', 'UnknownTool', 'unknown', false],
        ['DeleteFile', 'DeleteFile', 'unknown', false],
        ['WriteFile', 'WriteFile', 'unknown', false]
    ];

    for (const [requestedToolName, canonicalToolName, confidence, wasAlias] of cases) {
        const resolved = resolveToolIdentity({
            requestedToolName,
            toolArgs: { command: 'Get-ChildItem' }
        });

        assert.equal(resolved.requestedToolName, requestedToolName);
        assert.equal(resolved.canonicalToolName, canonicalToolName);
        assert.equal(resolved.confidence, confidence);
        assert.equal(resolved.wasAlias, wasAlias);
    }
});

test('ToolIdentityResolver extracts only toolArgs.command as command', () => {
    const withPrimaryCommand = resolveToolIdentity({
        requestedToolName: 'PowerShellExecutor',
        toolArgs: {
            command: ' Get-ChildItem ',
            command1: 'Remove-Item'
        }
    });
    assert.equal(withPrimaryCommand.command, 'Get-ChildItem');

    const withoutPrimaryCommand = resolveToolIdentity({
        requestedToolName: 'PowerShellExecutor',
        toolArgs: {
            command1: 'Get-ChildItem'
        }
    });
    assert.equal(withoutPrimaryCommand.command, null);
});

test('ToolIdentityResolver lets an explicit plugin registry exact match win over aliases', () => {
    const pluginRegistry = new Map([
        ['PowerShellExecutor', {}]
    ]);

    const resolved = resolveToolIdentity({
        requestedToolName: 'PowerShellExecutor',
        pluginRegistry
    });

    assert.equal(resolved.canonicalToolName, 'PowerShellExecutor');
    assert.equal(resolved.registeredPluginName, 'PowerShellExecutor');
    assert.equal(resolved.confidence, 'exact');
    assert.equal(resolved.wasAlias, false);
});
