const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_TOOL_APPROVAL_CONFIG,
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
        debugMode: 'verbose'
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [
        'enabled must be a boolean',
        'approveAll must be a boolean',
        'debugMode must be a boolean',
        'timeoutMinutes must be a positive number',
        'approvalList must contain only non-empty strings'
    ]);
});
