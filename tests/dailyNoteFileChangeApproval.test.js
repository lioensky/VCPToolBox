'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const testRoot = path.join(os.tmpdir(), `vcp-dailynote-plugin-${process.pid}`);
process.env.KNOWLEDGEBASE_ROOT_PATH = testRoot;
process.env.PROJECT_BASE_PATH = testRoot;
process.env.DAILY_NOTE_EXTENSION = 'txt';

const { ChangeProposalService } = require('../Plugin/FileChangeApproval/FileChangeApproval');
const dailyNote = require('../Plugin/DailyNote/dailynote');

async function createService(root) {
    const stateDir = path.join(root, 'approval-state');
    const service = new ChangeProposalService({
        pluginDir: root,
        stateDir,
        configPath: path.join(root, 'config.env'),
        config: { RequireUserApproval: true }
    });
    service.initialize();
    return service;
}

test('DailyNote create and update use the injected plugin service', async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(testRoot, { recursive: true });
    const service = await createService(testRoot);
    dailyNote.initialize({}, { changeProposalService: service });

    try {
        const createResult = await dailyNote.processToolCall({
            command: 'create',
            maid: 'PluginTest',
            Date: '2026-08-23',
            Content: '用于测试插件审批接入的日记内容。\nTag: 测试'
        });

        assert.equal(createResult.status, 'success');
        assert.equal(createResult.result.proposalStatus, 'pending_approval');
        assert.equal(createResult.result.folder, undefined);
        assert.equal(createResult.result.fileName, undefined);

        const pendingCreate = service.listProposals({
            status: 'pending_approval'
        })[0];
        assert.ok(pendingCreate);

        const appliedCreate = await service.approveProposal(
            pendingCreate.proposalId
        );
        assert.equal(appliedCreate.status, 'applied');

        const files = await fs.readdir(path.join(testRoot, 'PluginTest'));
        assert.equal(files.length, 1);
        const filePath = path.join(testRoot, 'PluginTest', files[0]);
        const beforeUpdate = await fs.readFile(filePath, 'utf8');

        const updateResult = await dailyNote.processToolCall({
            command: 'update',
            maid: 'PluginTest',
            target: '用于测试插件审批接入的日记内容。',
            replace: '已经审批后的新日记内容。'
        });

        assert.equal(updateResult.status, 'success');
        assert.equal(updateResult.result.proposalStatus, 'pending_approval');
        assert.equal(await fs.readFile(filePath, 'utf8'), beforeUpdate);

        const pendingUpdate = service.listProposals({
            status: 'pending_approval'
        }).find(item => item.operationType === 'update');
        assert.ok(pendingUpdate);
        const appliedUpdate = await service.approveProposal(
            pendingUpdate.proposalId
        );
        assert.equal(appliedUpdate.status, 'applied');
        assert.match(await fs.readFile(filePath, 'utf8'), /已经审批后的新日记内容/);
    } finally {
        await dailyNote.shutdown();
        await service.shutdown();
        await fs.rm(testRoot, { recursive: true, force: true });
    }
});

test('DailyNote falls back to direct writing without the plugin service', async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(testRoot, { recursive: true });
    dailyNote.initialize({}, {});

    try {
        const result = await dailyNote.processToolCall({
            command: 'create',
            maid: 'FallbackTest',
            Date: '2026-08-23',
            Content: '用于测试兼容直写模式的日记内容。\nTag: 测试'
        });

        assert.equal(result.status, 'success');
        assert.equal(result.result.proposalStatus, undefined);
        const files = await fs.readdir(path.join(testRoot, 'FallbackTest'));
        assert.equal(files.length, 1);
    } finally {
        await dailyNote.shutdown();
        await fs.rm(testRoot, { recursive: true, force: true });
    }
});

test('DailyNote auto-approval applies create and update through the plugin service', async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(testRoot, { recursive: true });
    const service = await createService(testRoot);
    service.config.requireUserApproval = false;
    dailyNote.initialize({}, { changeProposalService: service });

    try {
        const createResult = await dailyNote.processToolCall({
            command: 'create',
            maid: 'AutoApprovalTest',
            Date: '2026-08-23',
            Content: '自动批准模式下的日记内容。\nTag: 测试'
        });

        assert.equal(createResult.status, 'success');
        assert.equal(createResult.result.proposalStatus, 'applied');
        assert.equal(createResult.result.approvalMode, 'auto');
        assert.ok(createResult.result.targetFile);
        const filePath = createResult.result.targetFile;
        const beforeUpdate = await fs.readFile(filePath, 'utf8');

        const updateResult = await dailyNote.processToolCall({
            command: 'update',
            maid: 'AutoApprovalTest',
            target: '自动批准模式下的日记内容。\nTag: 测试',
            replace: '自动批准模式下已经更新的日记内容。\nTag: 测试'
        });

        assert.equal(updateResult.status, 'success');
        assert.equal(updateResult.result.proposalStatus, 'applied');
        assert.equal(updateResult.result.approvalMode, 'auto');
        assert.notEqual(await fs.readFile(filePath, 'utf8'), beforeUpdate);
        assert.match(await fs.readFile(filePath, 'utf8'), /已经更新/);
    } finally {
        await dailyNote.shutdown();
        await service.shutdown();
        await fs.rm(testRoot, { recursive: true, force: true });
    }
});
