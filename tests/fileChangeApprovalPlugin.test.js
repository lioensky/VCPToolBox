'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const plugin = require('../Plugin/FileChangeApproval/FileChangeApproval');

async function createRuntime() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-file-change-approval-'));
    const stateDir = path.join(root, 'state');
    const service = new plugin.ChangeProposalService({
        pluginDir: root,
        stateDir,
        configPath: path.join(root, 'config.env'),
        config: { RequireUserApproval: true }
    });
    service.initialize();
    return {
        root,
        service,
        async cleanup() {
            await service.shutdown();
            await fs.rm(root, { recursive: true, force: true });
        }
    };
}

test('service plugin persists manual proposals and applies after approval', async () => {
    const context = await createRuntime();
    try {
        const filePath = path.join(context.root, 'notes', 'manual.txt');
        context.service.registerApplyHandler('TestPlugin', async proposal => {
            await fs.mkdir(path.dirname(proposal.path), { recursive: true });
            await fs.writeFile(proposal.path, proposal.afterContent, 'utf8');
            return { targetFile: proposal.path };
        });

        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: filePath,
            beforeExists: false,
            afterContent: 'after'
        });

        assert.equal(pending.status, 'pending_approval');
        await assert.rejects(fs.access(filePath));

        const detail = await context.service.getProposal(
            pending.proposalId,
            { includeContent: true }
        );
        assert.equal(detail.beforeContent, '');
        assert.equal(detail.afterContent, 'after');
        assert.equal(detail.diff.additions, 1);

        const applied = await context.service.approveProposal(pending.proposalId);
        assert.equal(applied.status, 'applied');
        assert.equal(await fs.readFile(filePath, 'utf8'), 'after');
    } finally {
        await context.cleanup();
    }
});

test('automatic mode applies immediately while retaining snapshots', async () => {
    const context = await createRuntime();
    try {
        context.service.config.requireUserApproval = false;
        const filePath = path.join(context.root, 'notes', 'auto.txt');
        context.service.registerApplyHandler('TestPlugin', async proposal => {
            await fs.mkdir(path.dirname(proposal.path), { recursive: true });
            await fs.writeFile(proposal.path, proposal.afterContent, 'utf8');
            return { targetFile: proposal.path };
        });

        const applied = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: filePath,
            beforeExists: false,
            afterContent: 'automatic'
        });

        assert.equal(applied.status, 'applied');
        assert.equal(applied.approvalMode, 'auto');
        assert.equal(applied.approvalSource, 'system');
        const detail = await context.service.getProposal(
            applied.proposalId,
            { includeContent: true }
        );
        assert.equal(detail.afterContent, 'automatic');
    } finally {
        await context.cleanup();
    }
});

test('rejected proposals keep snapshots and do not modify the target file', async () => {
    const context = await createRuntime();
    try {
        const filePath = path.join(context.root, 'notes', 'rejected.txt');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'before', 'utf8');

        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'update',
            operationType: 'update',
            path: filePath,
            beforeExists: true,
            beforeContent: 'before',
            afterContent: 'after'
        });

        const rejected = context.service.rejectProposal(
            pending.proposalId,
            '不符合当前修改意图',
            'reviewer'
        );
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.rejectionReason, '不符合当前修改意图');
        assert.equal(await fs.readFile(filePath, 'utf8'), 'before');

        const detail = await context.service.getProposal(
            pending.proposalId,
            { includeContent: true }
        );
        assert.equal(detail.beforeContent, 'before');
        assert.equal(detail.afterContent, 'after');
    } finally {
        await context.cleanup();
    }
});

test('pending proposals and snapshots survive service restart', async () => {
    const context = await createRuntime();
    const filePath = path.join(context.root, 'notes', 'restart.txt');
    let restarted = null;
    try {
        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: filePath,
            beforeExists: false,
            afterContent: 'persisted'
        });
        await context.service.shutdown();

        restarted = new plugin.ChangeProposalService({
            pluginDir: context.root,
            stateDir: path.join(context.root, 'state'),
            configPath: path.join(context.root, 'config.env'),
            config: { RequireUserApproval: true }
        });
        restarted.initialize();
        restarted.registerApplyHandler('TestPlugin', async proposal => {
            await fs.mkdir(path.dirname(proposal.path), { recursive: true });
            await fs.writeFile(proposal.path, proposal.afterContent, 'utf8');
        });

        const restored = await restarted.getProposal(
            pending.proposalId,
            { includeContent: true }
        );
        assert.equal(restored.status, 'pending_approval');
        assert.equal(restored.afterContent, 'persisted');

        const applied = await restarted.approveProposal(pending.proposalId);
        assert.equal(applied.status, 'applied');
        await restarted.shutdown();
    } finally {
        if (restarted?.initialized) await restarted.shutdown();
        if (context.service.initialized) await context.service.shutdown();
        await fs.rm(context.root, { recursive: true, force: true });
    }
});

test('config save requires boolean and writes the plugin config atomically', async () => {
    const context = await createRuntime();
    try {
        let reloadCount = 0;
        context.service.setDependencies({
            pluginManager: {
                async loadPlugins() {
                    reloadCount++;
                }
            }
        });

        await assert.rejects(
            context.service.saveConfig('false'),
            error => error.statusCode === 400
        );

        const saved = await context.service.saveConfig(false);
        assert.deepEqual(saved, { requireUserApproval: false });
        assert.equal(reloadCount, 1);
        assert.match(await fs.readFile(context.service.configPath, 'utf8'), /RequireUserApproval=false/);
    } finally {
        await context.cleanup();
    }
});

test('missing snapshots are reported without hiding the stored diff', async () => {
    const context = await createRuntime();
    try {
        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: path.join(context.root, 'missing-snapshot.txt'),
            beforeExists: false,
            afterContent: 'content'
        });
        const row = context.service.db.prepare(
            'SELECT before_snapshot FROM change_proposals WHERE id = ?'
        ).get(pending.proposalId);
        await fs.rm(path.join(context.service.snapshotDir, row.before_snapshot), { force: true });

        const detail = await context.service.getProposal(
            pending.proposalId,
            { includeContent: true }
        );
        assert.match(detail.snapshotReadError, /ENOENT|no such file|不存在/i);
        assert.equal(detail.diff.additions, 1);
    } finally {
        await context.cleanup();
    }
});

test('deleting a terminal proposal removes its record and snapshots', async () => {
    const context = await createRuntime();
    try {
        const filePath = path.join(context.root, 'notes', 'deletable.txt');
        context.service.registerApplyHandler('TestPlugin', async proposal => {
            await fs.mkdir(path.dirname(proposal.path), { recursive: true });
            await fs.writeFile(proposal.path, proposal.afterContent, 'utf8');
        });

        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: filePath,
            beforeExists: false,
            afterContent: 'delete me'
        });
        const applied = await context.service.approveProposal(pending.proposalId);
        assert.equal(applied.status, 'applied');

        const snapshotDirectory = path.join(
            context.service.snapshotDir,
            pending.proposalId
        );
        assert.ok(await fs.stat(snapshotDirectory));

        const deleted = await context.service.deleteProposal(pending.proposalId);
        assert.deepEqual(deleted, {
            proposalId: pending.proposalId,
            status: 'deleted'
        });
        assert.equal(
            context.service.db.prepare(
                'SELECT 1 FROM change_proposals WHERE id = ?'
            ).get(pending.proposalId),
            undefined
        );
        await assert.rejects(fs.stat(snapshotDirectory));
        await assert.rejects(context.service.deleteProposal(pending.proposalId), {
            statusCode: 404
        });
    } finally {
        await context.cleanup();
    }
});

test('pending proposals cannot be deleted before approval or rejection', async () => {
    const context = await createRuntime();
    try {
        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: path.join(context.root, 'pending.txt'),
            beforeExists: false,
            afterContent: 'keep pending'
        });

        await assert.rejects(
            context.service.deleteProposal(pending.proposalId),
            error => error.statusCode === 409
        );
        assert.equal(
            context.service.listProposals({
                status: 'pending_approval'
            }).length,
            1
        );
    } finally {
        await context.cleanup();
    }
});

test('terminal proposals can be archived and restored without removing snapshots', async () => {
    const context = await createRuntime();
    try {
        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: path.join(context.root, 'archived.txt'),
            beforeExists: false,
            afterContent: 'archive me'
        });
        const rejected = context.service.rejectProposal(pending.proposalId);
        assert.equal(rejected.status, 'rejected');

        const archived = context.service.archiveProposal(pending.proposalId);
        assert.equal(archived.archived, true);
        assert.equal(
            context.service.listProposals().some(item => item.proposalId === pending.proposalId),
            false
        );
        assert.equal(
            context.service.listProposals({ archived: true })[0].proposalId,
            pending.proposalId
        );
        await fs.access(
            path.join(context.service.snapshotDir, pending.proposalId, 'after.txt')
        );

        const restored = context.service.archiveProposal(pending.proposalId, false);
        assert.equal(restored.archived, false);
        assert.equal(
            context.service.listProposals()[0].proposalId,
            pending.proposalId
        );
    } finally {
        await context.cleanup();
    }
});

test('pending proposals cannot be archived before approval or rejection', async () => {
    const context = await createRuntime();
    try {
        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'write',
            operationType: 'create',
            path: path.join(context.root, 'pending-archive.txt'),
            beforeExists: false,
            afterContent: 'keep active'
        });

        assert.throws(
            () => context.service.archiveProposal(pending.proposalId),
            error => error.statusCode === 409
        );
    } finally {
        await context.cleanup();
    }
});

test('changed source file becomes stale instead of being overwritten', async () => {
    const context = await createRuntime();
    try {
        const filePath = path.join(context.root, 'notes', 'stale.txt');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, 'before', 'utf8');
        context.service.registerApplyHandler('TestPlugin', async proposal => {
            await fs.writeFile(proposal.path, proposal.afterContent, 'utf8');
        });

        const pending = await context.service.createProposal({
            sourcePlugin: 'TestPlugin',
            command: 'update',
            operationType: 'update',
            path: filePath,
            beforeExists: true,
            beforeContent: 'before',
            afterContent: 'after'
        });
        await fs.writeFile(filePath, 'changed by user', 'utf8');

        const stale = await context.service.approveProposal(pending.proposalId);
        assert.equal(stale.status, 'stale');
        assert.equal(await fs.readFile(filePath, 'utf8'), 'changed by user');
    } finally {
        await context.cleanup();
    }
});

test('plugin registers all management API endpoints', () => {
    const routes = [];
    const adminRouter = {
        get: (pathName, handler) => routes.push({ method: 'GET', pathName, handler }),
        post: (pathName, handler) => routes.push({ method: 'POST', pathName, handler }),
        delete: (pathName, handler) => routes.push({ method: 'DELETE', pathName, handler })
    };

    plugin.registerRoutes(null, adminRouter, {}, path.dirname(__dirname));

    assert.deepEqual(
        routes.map(route => `${route.method} ${route.pathName}`),
        [
            'GET /change-proposals/config',
            'POST /change-proposals/config',
            'GET /change-proposals',
            'GET /change-proposals/:proposalId',
            'POST /change-proposals/:proposalId/approve',
            'POST /change-proposals/:proposalId/reject',
            'POST /change-proposals/:proposalId/archive',
            'DELETE /change-proposals/:proposalId'
        ]
    );
});
