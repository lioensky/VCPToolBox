const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'chokidar') {
        return {
            watch() {
                return {
                    on() {
                        return this;
                    },
                    close() {}
                };
            }
        };
    }

    return originalLoad.call(this, request, parent, isMain);
};
const ToolApprovalManager = require('../modules/toolApprovalManager');
Module._load = originalLoad;

function createManager(config) {
    const manager = new ToolApprovalManager(path.join(
        os.tmpdir(),
        `vcp-tool-approval-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    ));
    manager.config = {
        enabled: true,
        timeoutMinutes: 5,
        approveAll: false,
        approvalList: [],
        ...config
    };
    return manager;
}

function withManager(config, run) {
    const manager = createManager(config);
    try {
        run(manager);
    } finally {
        manager.shutdown();
    }
}

function assertDecisionShape(decision) {
    assert.deepEqual(Object.keys(decision).sort(), [
        'canonicalToolName',
        'matchedCommand',
        'matchedRule',
        'notifyAiOnReject',
        'requestedToolName',
        'requiresApproval',
        'wasAlias'
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, 'effect'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, 'effectClass'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(decision, 'argsPreview'), false);
}

test('legacy PowerShellExecutor rule protects canonical ServerPowerShellExecutor calls', () => {
    withManager({ approvalList: ['PowerShellExecutor'] }, (manager) => {
        const decision = manager.getApprovalDecision('ServerPowerShellExecutor', {
            command: 'Get-ChildItem'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'PowerShellExecutor');
        assert.equal(decision.canonicalToolName, 'ServerPowerShellExecutor');
        assert.equal(decision.wasAlias, false);
    });
});

test('registered plugin names that match legacy aliases remain exact', () => {
    withManager({ approvalList: ['ServerPowerShellExecutor'] }, (manager) => {
        const pluginRegistry = new Map([
            ['PowerShellExecutor', {}],
            ['ServerPowerShellExecutor', {}]
        ]);

        const decision = manager.getApprovalDecision('PowerShellExecutor', {
            command: 'Get-ChildItem'
        }, { pluginRegistry });

        assert.equal(decision.requiresApproval, false);
        assert.equal(decision.requestedToolName, 'PowerShellExecutor');
        assert.equal(decision.canonicalToolName, 'PowerShellExecutor');
        assert.equal(decision.wasAlias, false);
    });
});

test('canonical ServerPowerShellExecutor rule protects legacy PowerShellExecutor calls', () => {
    withManager({ approvalList: ['ServerPowerShellExecutor'] }, (manager) => {
        const decision = manager.getApprovalDecision('PowerShellExecutor', {
            command: 'Get-ChildItem'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'ServerPowerShellExecutor');
        assert.equal(decision.requestedToolName, 'PowerShellExecutor');
        assert.equal(decision.canonicalToolName, 'ServerPowerShellExecutor');
        assert.equal(decision.wasAlias, true);
    });
});

test('legacy command-specific PowerShellExecutor rule protects canonical calls', () => {
    withManager({ approvalList: ['PowerShellExecutor:Get-ChildItem'] }, (manager) => {
        const decision = manager.getApprovalDecision('ServerPowerShellExecutor', {
            command: 'Get-ChildItem'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'PowerShellExecutor:Get-ChildItem');
        assert.equal(decision.matchedCommand, 'Get-ChildItem');
    });
});

test('canonical command-specific PowerShellExecutor rule protects legacy calls', () => {
    withManager({ approvalList: ['ServerPowerShellExecutor:Get-ChildItem'] }, (manager) => {
        const decision = manager.getApprovalDecision('PowerShellExecutor', {
            command: 'Get-ChildItem'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'ServerPowerShellExecutor:Get-ChildItem');
        assert.equal(decision.matchedCommand, 'Get-ChildItem');
    });
});

test('PowerShellExecutor rule does not protect unrelated ServerFileOperator calls', () => {
    withManager({ approvalList: ['PowerShellExecutor'] }, (manager) => {
        const decision = manager.getApprovalDecision('ServerFileOperator', {
            command: 'DeleteFile'
        });

        assert.equal(decision.requiresApproval, false);
        assert.equal(decision.matchedRule, null);
    });
});

test('legacy FileOperator rule protects canonical ServerFileOperator calls', () => {
    withManager({ approvalList: ['FileOperator'] }, (manager) => {
        const decision = manager.getApprovalDecision('ServerFileOperator', {
            command: 'DeleteFile'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'FileOperator');
    });
});

test('canonical command-specific ServerFileOperator rule protects legacy FileOperator calls', () => {
    withManager({ approvalList: ['ServerFileOperator:DeleteFile'] }, (manager) => {
        const decision = manager.getApprovalDecision('FileOperator', {
            command: 'DeleteFile'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'ServerFileOperator:DeleteFile');
        assert.equal(decision.matchedCommand, 'DeleteFile');
    });
});

test('SciCalculator approval behavior remains unchanged', () => {
    withManager({ approvalList: ['SciCalculator'] }, (manager) => {
        const decision = manager.getApprovalDecision('SciCalculator', {
            command: 'SciCalculatorRequest'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'SciCalculator');
        assert.equal(decision.matchedCommand, null);
    });
});

test('approveAll behavior remains unchanged', () => {
    withManager({ approveAll: true, approvalList: [] }, (manager) => {
        const decision = manager.getApprovalDecision('UnknownTool', {
            command: 'Whatever'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.notifyAiOnReject, true);
        assert.equal(decision.matchedRule, '__APPROVE_ALL__');
        assert.equal(decision.matchedCommand, null);
    });
});

test('SilentReject behavior remains unchanged', () => {
    withManager({ approvalList: ['SciCalculator::SilentReject'] }, (manager) => {
        const decision = manager.getApprovalDecision('SciCalculator', {
            command: 'SciCalculatorRequest'
        });

        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.notifyAiOnReject, false);
        assert.equal(decision.matchedRule, 'SciCalculator::SilentReject');
    });
});

test('unknown tool behavior remains exact-match only', () => {
    withManager({ approvalList: ['UnknownTool'] }, (manager) => {
        const exactDecision = manager.getApprovalDecision('UnknownTool', {
            command: 'Whatever'
        });
        assert.equal(exactDecision.requiresApproval, true);
        assert.equal(exactDecision.matchedRule, 'UnknownTool');

        const unrelatedDecision = manager.getApprovalDecision('AnotherUnknownTool', {
            command: 'Whatever'
        });
        assert.equal(unrelatedDecision.requiresApproval, false);
        assert.equal(unrelatedDecision.matchedRule, null);
    });
});

test('DeleteFile is not treated as a standalone FileOperator alias', () => {
    withManager({ approvalList: ['DeleteFile'] }, (manager) => {
        const decision = manager.getApprovalDecision('ServerFileOperator', {
            command: 'DeleteFile'
        });

        assert.equal(decision.requiresApproval, false);
        assert.equal(decision.matchedRule, null);
    });
});

test('approval decision shape stays unchanged after effect evidence integration', () => {
    withManager({ approvalList: ['ServerPowerShellExecutor:Get-ChildItem'] }, (manager) => {
        const decision = manager.getApprovalDecision('PowerShellExecutor', {
            command: 'Get-ChildItem',
            targetPath: 'C:\\safe',
            password: 'SECRET_VALUE_SHOULD_NOT_APPEAR'
        });

        assertDecisionShape(decision);
        assert.equal(decision.requiresApproval, true);
        assert.equal(decision.matchedRule, 'ServerPowerShellExecutor:Get-ChildItem');
        assert.equal(decision.matchedCommand, 'Get-ChildItem');
        assert.equal(decision.requestedToolName, 'PowerShellExecutor');
        assert.equal(decision.canonicalToolName, 'ServerPowerShellExecutor');
        assert.equal(decision.wasAlias, true);
    });
});

test('shouldApprove remains driven only by approval rules, not approval evidence enrichment', () => {
    withManager({ approvalList: ['ServerFileOperator:DeleteFile'] }, (manager) => {
        const deleteDecision = manager.getApprovalDecision('FileOperator', {
            command: 'DeleteFile',
            path: 'C:\\safe.txt',
            apiKey: 'SECRET_VALUE_SHOULD_NOT_APPEAR'
        });
        const writeDecision = manager.getApprovalDecision('FileOperator', {
            command: 'WriteFile',
            path: 'C:\\safe.txt'
        });

        assertDecisionShape(deleteDecision);
        assertDecisionShape(writeDecision);
        assert.equal(manager.shouldApprove('FileOperator', {
            command: 'DeleteFile',
            path: 'C:\\safe.txt'
        }), true);
        assert.equal(manager.shouldApprove('FileOperator', {
            command: 'WriteFile',
            path: 'C:\\safe.txt'
        }), false);
        assert.equal(deleteDecision.requiresApproval, true);
        assert.equal(deleteDecision.matchedRule, 'ServerFileOperator:DeleteFile');
        assert.equal(writeDecision.requiresApproval, false);
        assert.equal(writeDecision.matchedRule, null);
    });
});
