const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_TOOL_APPROVAL_CONFIG,
    SUPPORTED_TOOL_APPROVAL_KEYS,
    normalizeToolApprovalConfig,
    validateToolApprovalConfig
} = require('../modules/toolApprovalConfigSchema');

test('normalizeToolApprovalConfig preserves valid fields and canonicalizes legacy aliases', () => {
    const normalized = normalizeToolApprovalConfig({
        enabled: true,
        approveAll: true,
        timeout: 12.9,
        toolList: [' SciCalculator ', '', 'PowerShellExecutor:Get-ChildItem'],
        debugMode: true
    });

    assert.deepEqual(normalized, {
        enabled: true,
        approveAll: true,
        timeoutMinutes: 12,
        approvalList: ['SciCalculator', 'PowerShellExecutor:Get-ChildItem'],
        debugMode: true
    });
});

test('normalizeToolApprovalConfig does not floor fractional timeouts to zero', () => {
    const normalized = normalizeToolApprovalConfig({
        enabled: true,
        timeoutMinutes: 0.5
    });

    assert.equal(normalized.timeoutMinutes, 1);
});

test('normalizeToolApprovalConfig falls back to defaults for malformed input', () => {
    assert.deepEqual(normalizeToolApprovalConfig(null), DEFAULT_TOOL_APPROVAL_CONFIG);
    assert.deepEqual(normalizeToolApprovalConfig({
        enabled: 'yes',
        timeoutMinutes: -5,
        approvalList: 'bad'
    }), DEFAULT_TOOL_APPROVAL_CONFIG);
});

test('validateToolApprovalConfig rejects semantic schema errors', () => {
    const result = validateToolApprovalConfig({
        enabled: 'yes',
        approveAll: 1,
        timeoutMinutes: 0,
        approvalList: ['ok', ''],
        unexpectedKey: true,
        debugMode: 'verbose'
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [
        'unknown config keys: unexpectedKey',
        'enabled must be a boolean',
        'approveAll must be a boolean',
        'debugMode must be a boolean',
        'timeoutMinutes must be a positive number',
        'approvalList must contain only non-empty strings'
    ]);
});

test('supported tool approval keys list stays explicit', () => {
    assert.deepEqual(SUPPORTED_TOOL_APPROVAL_KEYS, [
        'enabled',
        'approveAll',
        'debugMode',
        'timeoutMinutes',
        'timeout',
        'approvalList',
        'toolList'
    ]);
});

test('validateToolApprovalConfig rejects typo-only objects', () => {
    const result = validateToolApprovalConfig({
        enbaled: true
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [
        'unknown config keys: enbaled',
        'config must include at least one supported field'
    ]);
});
