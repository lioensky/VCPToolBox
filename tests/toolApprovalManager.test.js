const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ToolApprovalManager = require('../modules/toolApprovalManager');

function createManager(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-approval-'));
    const configPath = path.join(dir, 'toolApprovalConfig.json');
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, ...config }), 'utf8');
    const manager = new ToolApprovalManager(configPath);
    manager.shutdown(); // 测试中无需文件监听，避免进程挂起
    return manager;
}

test('旧语法保持兼容：工具级 / 命令级 / SilentReject', () => {
    const m = createManager({
        approvalList: ['SciCalculator', 'FileOperator:DeleteFile', 'FileOperator:DeleteFile::SilentReject']
    });
    assert.equal(m.shouldApprove('SciCalculator', {}), true);
    assert.equal(m.shouldApprove('FileOperator', { command: 'ReadFile' }), false);
    const d = m.getApprovalDecision('FileOperator', { command: 'DeleteFile', filePath: 'H:/a.txt' });
    assert.equal(d.requiresApproval, true);
    assert.equal(d.notifyAiOnReject, false);
    assert.equal(d.matchedCommand, 'DeleteFile');
});

test('参数级路径规则：FileOperator:Path:[C:]', () => {
    const m = createManager({ approvalList: ['FileOperator:Path:[C:]'] });
    assert.equal(m.shouldApprove('FileOperator', { command: 'ReadFile', filePath: 'C:\\Windows\\win.ini' }), true);
    assert.equal(m.shouldApprove('FileOperator', { command: 'ReadFile', filePath: 'c:/Users/a.txt' }), true);
    assert.equal(m.shouldApprove('FileOperator', { command: 'CopyFile', sourcePath: 'H:/a', destinationPath: 'C:/b' }), true);
    assert.equal(m.shouldApprove('FileOperator', { command: 'ListDirectory', directoryPath: 'C:' }), true);
    assert.equal(m.shouldApprove('FileOperator', { command: 'ReadFile', filePath: 'H:\\VCP\\a.txt' }), false);
    assert.equal(m.shouldApprove('FileOperator', { command: 'ReadFile', filePath: 'file:///C:/x.txt' }), true);
});

test('路径规则：单字母盘符、路径边界、.. 折叠、通配', () => {
    const m = createManager({ approvalList: ['FileOperator:Path:[D]', 'FileOperator:Path:[H:\\work]', 'FileOperator:filePath:[*.env]'] });
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'D:/x' }), true);
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/work/a.txt' }), true);
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/work-old/a.txt' }), false);
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/other/../work/a.txt' }), true);
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/proj/config.env' }), true);
});

test('参数级优先于工具级；SilentReject 在参数级生效', () => {
    const m = createManager({ approvalList: ['FileOperator', 'FileOperator:Path:[C:]::SilentReject'] });
    const d = m.getApprovalDecision('FileOperator', { filePath: 'C:/a' });
    assert.equal(d.requiresApproval, true);
    assert.equal(d.notifyAiOnReject, false);
    assert.equal(m.getApprovalDecision('FileOperator', { filePath: 'H:/a' }).notifyAiOnReject, true);
});

test('白名单：PowerShellExecutor:command:[node] 免审核', () => {
    const m = createManager({
        approvalList: ['PowerShellExecutor'],
        whitelist: ['PowerShellExecutor:command:[node]']
    });
    const d = m.getApprovalDecision('PowerShellExecutor', { command: 'node server.js', executionType: 'blocking' });
    assert.equal(d.requiresApproval, false);
    assert.equal(d.whitelistedBy, 'PowerShellExecutor:command:[node]');
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Node -v' }), false);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'node' }), false);
    // 单词边界
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'nodemon app.js' }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'node-gyp rebuild' }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Remove-Item C:/x' }), true);
});

test('白名单防绕过：命令串联 / 子表达式 / 换行 / 批量命令', () => {
    const m = createManager({
        approvalList: ['PowerShellExecutor'],
        whitelist: ['PowerShellExecutor:command:[node]']
    });
    for (const cmd of [
        'node a.js; Remove-Item C:/x',
        'node a.js && del x',
        'node a.js | Out-File x',
        'node $(Remove-Item x)',
        'node -e "require(\'child_process\')"',
        'node a.js\nRemove-Item x',
        'node a.js > C:/Windows/x'
    ]) {
        assert.equal(m.shouldApprove('PowerShellExecutor', { command: cmd }), true, cmd);
    }
    assert.equal(m.shouldApprove('PowerShellExecutor', { command1: 'node a.js', command2: 'Remove-Item x' }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command1: 'node a.js', command2: 'node b.js' }), false);
});

test('白名单不能越级：工具级白名单无法豁免参数级审核', () => {
    const m = createManager({
        approvalList: ['FileOperator:Path:[C:]'],
        whitelist: ['FileOperator']
    });
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'C:/a' }), true);
});

test('路径白名单：所有路径参数都需在白名单内', () => {
    const m = createManager({
        approvalList: ['FileOperator:Path:[C:]', 'FileOperator:Path:[H:]'],
        whitelist: ['FileOperator:Path:[H:\\VCP\\workspace]']
    });
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/VCP/workspace/a.md' }), false);
    assert.equal(m.shouldApprove('FileOperator', { filePath: 'H:/VCP/workspace/../secret.txt' }), true);
    assert.equal(m.shouldApprove('FileOperator', { sourcePath: 'H:/VCP/workspace/a', destinationPath: 'C:/b' }), true);
});

test('approveAll 下白名单依然可豁免', () => {
    const m = createManager({ approveAll: true, whitelist: ['SciCalculator'] });
    assert.equal(m.shouldApprove('SciCalculator', {}), false);
    assert.equal(m.shouldApprove('FileOperator', {}), true);
});

test('审核关闭时一律放行', () => {
    const m = createManager({ enabled: false, approvalList: ['FileOperator'] });
    assert.equal(m.shouldApprove('FileOperator', {}), false);
});

test('复合命令兼容：必须显式开启，Set-Location 前缀放行整条命令', () => {
    const command = "Set-Location 'H:\\VCP\\VCPMain\\VCPChat'; $env:PUPPETEER_EXECUTABLE_PATH='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; node --test tests/compact-topic-drawer-layout.test.mjs";
    const baseConfig = {
        approvalList: ['PowerShellExecutor'],
        whitelist: ['PowerShellExecutor:command:[Set-Location]']
    };
    for (const flag of [undefined, false, 'true', 1]) {
        const m = createManager({ ...baseConfig, allowChainedCommandWhitelist: flag });
        assert.equal(m.shouldApprove('PowerShellExecutor', { command }), true);
    }
    const m = createManager({ ...baseConfig, allowChainedCommandWhitelist: true });
    assert.equal(m.getApprovalDecision('PowerShellExecutor', { command }).whitelistedBy,
        'PowerShellExecutor:command:[Set-Location]');
    // 兼容模式有意信任全部后续操作，不逐段审查。
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: command + '; Remove-Item x' }), false);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Set-LocationExtra x; node -v' }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Remove-Item x; Set-Location H:/work' }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', {
        command1: command, command2: 'Remove-Item x'
    }), true);
    assert.equal(m.shouldApprove('PowerShellExecutor', {
        command1: command, command2: 'Set-Location H:/work; node -v'
    }), false);
    m.config.allowChainedCommandWhitelist = false;
    assert.equal(m.shouldApprove('PowerShellExecutor', { command }), true);
});

test('复合命令兼容不改变白名单具体程度要求和单词边界', () => {
    const m = createManager({
        allowChainedCommandWhitelist: true,
        approvalList: ['PowerShellExecutor:command:[Set-Location]'],
        whitelist: ['PowerShellExecutor']
    });
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Set-Location H:/work; node -v' }), true);
    m.config.whitelist = ['PowerShellExecutor:command:[Set]'];
    assert.equal(m.shouldApprove('PowerShellExecutor', { command: 'Set-Location H:/work; node -v' }), true);
});