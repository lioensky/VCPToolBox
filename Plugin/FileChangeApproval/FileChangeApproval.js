'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PLUGIN_NAME = 'FileChangeApproval';
const DEFAULT_REQUIRE_USER_APPROVAL = false;
const DELETABLE_STATUSES = new Set([
    'applied',
    'rejected',
    'failed',
    'stale'
]);
const ARCHIVABLE_STATUSES = new Set([
    'applied',
    'rejected',
    'failed',
    'stale'
]);

let runtime = null;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function nowIso() {
    return new Date().toISOString();
}

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function asBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).trim().toLowerCase() === 'true';
}

function splitLines(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n');
}

function buildUnifiedDiff(before, after, beforeLabel, afterLabel) {
    const left = splitLines(before);
    const right = splitLines(after);
    const lcs = Array.from({ length: left.length + 1 }, () => (
        new Array(right.length + 1).fill(0)
    ));

    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            lcs[i][j] = left[i - 1] === right[j - 1]
                ? lcs[i - 1][j - 1] + 1
                : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
        }
    }

    const operations = [];
    let i = left.length;
    let j = right.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && left[i - 1] === right[j - 1]) {
            operations.unshift({ type: ' ', line: left[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
            operations.unshift({ type: '+', line: right[j - 1] });
            j--;
        } else {
            operations.unshift({ type: '-', line: left[i - 1] });
            i--;
        }
    }

    const changed = operations
        .map((operation, index) => ({ ...operation, index }))
        .filter(operation => operation.type !== ' ');

    if (changed.length === 0) {
        return {
            unified: `--- ${beforeLabel}\n+++ ${afterLabel}\n`,
            additions: 0,
            deletions: 0,
            changedLines: 0
        };
    }

    const context = 3;
    const hunks = [];
    let cursor = 0;
    while (cursor < changed.length) {
        let start = Math.max(0, changed[cursor].index - context);
        let end = Math.min(operations.length, changed[cursor].index + context + 1);
        cursor++;

        while (cursor < changed.length && changed[cursor].index <= end + context) {
            end = Math.min(operations.length, changed[cursor].index + context + 1);
            cursor++;
        }

        const hunk = operations.slice(start, end);
        let oldStart = 1;
        let newStart = 1;
        for (let index = 0; index < start; index++) {
            if (operations[index].type !== '+') oldStart++;
            if (operations[index].type !== '-') newStart++;
        }

        const oldCount = hunk.filter(item => item.type !== '+').length;
        const newCount = hunk.filter(item => item.type !== '-').length;
        const oldRange = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
        const newRange = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;

        hunks.push(
            `@@ -${oldRange} +${newRange} @@\n`
            + hunk.map(item => `${item.type}${item.line}`).join('\n')
        );
    }

    return {
        unified: `--- ${beforeLabel}\n+++ ${afterLabel}\n${hunks.join('\n')}`,
        additions: operations.filter(item => item.type === '+').length,
        deletions: operations.filter(item => item.type === '-').length,
        changedLines: changed.length
    };
}

function normalizeConfig(config = {}) {
    return {
        requireUserApproval: asBoolean(
            config.RequireUserApproval ?? config.requireUserApproval,
            DEFAULT_REQUIRE_USER_APPROVAL
        ),
        debugMode: asBoolean(config.DebugMode ?? config.debugMode, false)
    };
}

class ChangeProposalService {
    constructor(options = {}) {
        this.pluginDir = options.pluginDir;
        this.stateDir = options.stateDir;
        this.configPath = options.configPath;
        this.config = normalizeConfig(options.config);
        this.db = null;
        this.applyHandlers = new Map();
        this.activeApplyCount = 0;
        this.idleWaiters = [];
        this.initialized = false;
        this.dependencies = options.dependencies || {};
    }

    initialize() {
        if (this.initialized) return this.getStatus();

        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.mkdirSync(this.snapshotDir, { recursive: true });
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS change_proposals (
                id TEXT PRIMARY KEY,
                source_plugin TEXT NOT NULL,
                command TEXT NOT NULL,
                agent_name TEXT,
                session_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                path TEXT NOT NULL,
                before_exists INTEGER NOT NULL DEFAULT 0,
                before_hash TEXT,
                after_hash TEXT NOT NULL,
                before_size INTEGER NOT NULL DEFAULT 0,
                after_size INTEGER NOT NULL DEFAULT 0,
                encoding TEXT NOT NULL DEFAULT 'utf8',
                approval_mode TEXT NOT NULL,
                approval_source TEXT,
                status TEXT NOT NULL,
                rejection_reason TEXT,
                error_message TEXT,
                result_json TEXT,
                before_snapshot TEXT,
                after_snapshot TEXT,
                diff_json TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_change_proposals_status
                ON change_proposals(status);
            CREATE INDEX IF NOT EXISTS idx_change_proposals_created_at
                ON change_proposals(created_at);
            CREATE INDEX IF NOT EXISTS idx_change_proposals_source_plugin
                ON change_proposals(source_plugin);
        `);
        const columns = new Set(
            this.db.prepare('PRAGMA table_info(change_proposals)').all().map(column => column.name)
        );
        if (!columns.has('archived')) {
            this.db.exec(
                'ALTER TABLE change_proposals ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'
            );
        }
        if (!columns.has('archived_at')) {
            this.db.exec(
                'ALTER TABLE change_proposals ADD COLUMN archived_at TEXT'
            );
        }
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_change_proposals_archived
                ON change_proposals(archived);
        `);
        this.initialized = true;
        this.debug('initialized');
        return this.getStatus();
    }

    async shutdown() {
        await this.waitForIdle();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.initialized = false;
        this.applyHandlers.clear();
    }

    setDependencies(dependencies = {}) {
        this.dependencies = {
            ...this.dependencies,
            ...dependencies
        };
    }

    debug(message, ...args) {
        if (this.config.debugMode) {
            console.error(`[${PLUGIN_NAME}][Debug] ${message}`, ...args);
        }
    }

    get dbPath() {
        return path.join(this.stateDir, 'change-proposals.sqlite3');
    }

    get snapshotDir() {
        return path.join(this.stateDir, 'snapshots');
    }

    getConfig() {
        return {
            requireUserApproval: this.config.requireUserApproval
        };
    }

    getStatus() {
        return {
            initialized: this.initialized,
            requireUserApproval: this.config.requireUserApproval,
            configPath: this.configPath,
            dbPath: this.dbPath,
            snapshotDir: this.snapshotDir,
            activeApplies: this.activeApplyCount
        };
    }

    registerApplyHandler(sourcePlugin, handler) {
        if (!sourcePlugin || typeof handler !== 'function') {
            throw new TypeError('sourcePlugin and handler are required');
        }
        this.applyHandlers.set(String(sourcePlugin), handler);
    }

    async waitForIdle() {
        if (this.activeApplyCount === 0) return;
        await new Promise(resolve => this.idleWaiters.push(resolve));
    }

    _markApplyStart() {
        this.activeApplyCount++;
    }

    _markApplyEnd() {
        this.activeApplyCount = Math.max(0, this.activeApplyCount - 1);
        if (this.activeApplyCount === 0) {
            const waiters = this.idleWaiters.splice(0);
            waiters.forEach(resolve => resolve());
        }
    }

    isPathReserved(filePath) {
        this.initialize();
        const row = this.db.prepare(`
            SELECT 1 FROM change_proposals
            WHERE path = ?
              AND status IN ('pending_approval', 'approved', 'applying')
            LIMIT 1
        `).get(path.resolve(filePath));
        return !!row;
    }

    _snapshotRelativePath(proposalId, side) {
        return path.join(proposalId, `${side}.txt`);
    }

    async _writeSnapshot(relativePath, content) {
        const absolutePath = path.resolve(this.snapshotDir, relativePath);
        const root = path.resolve(this.snapshotDir);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
            throw new Error('Invalid snapshot path');
        }
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
        const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(temporaryPath, content, 'utf8');
        await fsp.rename(temporaryPath, absolutePath);
    }

    async _readSnapshot(relativePath) {
        const absolutePath = path.resolve(this.snapshotDir, relativePath);
        const root = path.resolve(this.snapshotDir);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
            throw new Error('Invalid snapshot path');
        }
        return fsp.readFile(absolutePath, 'utf8');
    }

    async _removeSnapshot(relativePath) {
        if (!relativePath) return;
        const absolutePath = path.resolve(this.snapshotDir, relativePath);
        const root = path.resolve(this.snapshotDir);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
            throw new Error('Invalid snapshot path');
        }
        try {
            await fsp.rm(absolutePath, { force: true });
        } catch (error) {
            throw new Error(`Failed to remove snapshot: ${error.message}`);
        }
    }

    async _removeSnapshotDirectory(proposalId) {
        const absolutePath = path.resolve(this.snapshotDir, String(proposalId));
        const root = path.resolve(this.snapshotDir);
        if (!absolutePath.startsWith(`${root}${path.sep}`)) {
            throw new Error('Invalid snapshot path');
        }
        await fsp.rm(absolutePath, { recursive: true, force: true });
    }

    _rowToSummary(row) {
        if (!row) return null;
        return {
            proposalId: row.id,
            sourcePlugin: row.source_plugin,
            command: row.command,
            agentName: row.agent_name || '',
            sessionId: row.session_id || '',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            operationType: row.operation_type,
            path: row.path,
            beforeExists: row.before_exists === 1,
            beforeHash: row.before_hash || null,
            afterHash: row.after_hash,
            beforeSize: row.before_size,
            afterSize: row.after_size,
            encoding: row.encoding,
            approvalMode: row.approval_mode,
            approvalSource: row.approval_source || null,
            status: row.status,
            rejectionReason: row.rejection_reason || '',
            errorMessage: row.error_message || '',
            result: row.result_json ? JSON.parse(row.result_json) : null,
            diff: row.diff_json ? JSON.parse(row.diff_json) : null,
            archived: row.archived === 1,
            archivedAt: row.archived_at || null
        };
    }

    async _readCurrentVersion(filePath) {
        try {
            const stats = await fsp.stat(filePath);
            const content = await fsp.readFile(filePath, 'utf8');
            return {
                exists: true,
                content,
                hash: sha256(content),
                size: stats.size
            };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { exists: false, content: '', hash: null, size: 0 };
            }
            throw error;
        }
    }

    async createProposal(input = {}) {
        this.initialize();
        const sourcePlugin = String(input.sourcePlugin || '').trim();
        const command = String(input.command || '').trim();
        const rawPath = String(input.path || '').trim();
        const filePath = path.resolve(rawPath);
        const beforeExists = input.beforeExists !== false;
        const beforeContent = beforeExists ? String(input.beforeContent ?? '') : '';
        const afterContent = String(input.afterContent ?? '');

        if (!sourcePlugin || !command || !rawPath) {
            throw new Error('sourcePlugin, command and path are required');
        }
        if (!beforeExists && input.operationType !== 'create') {
            throw new Error('beforeExists=false is only valid for create proposals');
        }

        const proposalId = `cp-${Date.now()}-${crypto.randomUUID()}`;
        const createdAt = nowIso();
        const approvalMode = this.config.requireUserApproval ? 'manual' : 'auto';
        const diff = buildUnifiedDiff(
            beforeContent,
            afterContent,
            `${filePath} (before)`,
            `${filePath} (after)`
        );
        const beforeSnapshot = this._snapshotRelativePath(proposalId, 'before');
        const afterSnapshot = this._snapshotRelativePath(proposalId, 'after');

        await this._writeSnapshot(beforeSnapshot, beforeContent);
        await this._writeSnapshot(afterSnapshot, afterContent);

        const row = {
            id: proposalId,
            source_plugin: sourcePlugin,
            command,
            agent_name: input.agentName ? String(input.agentName) : '',
            session_id: input.sessionId ? String(input.sessionId) : '',
            created_at: createdAt,
            updated_at: createdAt,
            operation_type: String(input.operationType || 'update'),
            path: filePath,
            before_exists: beforeExists ? 1 : 0,
            before_hash: beforeExists ? sha256(beforeContent) : null,
            after_hash: sha256(afterContent),
            before_size: Buffer.byteLength(beforeContent, 'utf8'),
            after_size: Buffer.byteLength(afterContent, 'utf8'),
            encoding: String(input.encoding || 'utf8'),
            approval_mode: approvalMode,
            approval_source: approvalMode === 'auto' ? 'system' : null,
            status: approvalMode === 'auto' ? 'approved' : 'pending_approval',
            rejection_reason: null,
            error_message: null,
            result_json: null,
            before_snapshot: beforeSnapshot,
            after_snapshot: afterSnapshot,
            diff_json: JSON.stringify(diff),
            archived: 0,
            archived_at: null
        };

        this.db.prepare(`
            INSERT INTO change_proposals (
                id, source_plugin, command, agent_name, session_id,
                created_at, updated_at, operation_type, path,
                before_exists, before_hash, after_hash, before_size, after_size,
                encoding, approval_mode, approval_source, status,
                rejection_reason, error_message, result_json,
                before_snapshot, after_snapshot, diff_json,
                archived, archived_at
            ) VALUES (
                @id, @source_plugin, @command, @agent_name, @session_id,
                @created_at, @updated_at, @operation_type, @path,
                @before_exists, @before_hash, @after_hash, @before_size, @after_size,
                @encoding, @approval_mode, @approval_source, @status,
                @rejection_reason, @error_message, @result_json,
                @before_snapshot, @after_snapshot, @diff_json,
                @archived, @archived_at
            )
        `).run(row);

        const proposal = this._rowToSummary(row);
        if (approvalMode === 'auto') {
            return this._applyProposal(proposalId);
        }
        return proposal;
    }

    listProposals(query = {}) {
        this.initialize();
        const clauses = [];
        const params = {};
        const archivedQuery = query.archived;
        if (
            archivedQuery === undefined
            || archivedQuery === null
            || archivedQuery === ''
        ) {
            clauses.push('archived = 0');
        } else if (String(archivedQuery).toLowerCase() !== 'all') {
            clauses.push('archived = @archived');
            params.archived = (
                archivedQuery === true
                || String(archivedQuery).toLowerCase() === 'true'
            ) ? 1 : 0;
        }
        if (query.status && query.status !== 'all') {
            clauses.push('status = @status');
            params.status = String(query.status);
        }
        if (query.sourcePlugin && query.sourcePlugin !== 'all') {
            clauses.push('source_plugin = @sourcePlugin');
            params.sourcePlugin = String(query.sourcePlugin);
        }
        if (query.search) {
            clauses.push('(path LIKE @search OR agent_name LIKE @search OR command LIKE @search)');
            params.search = `%${String(query.search)}%`;
        }
        const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
        params.limit = limit;
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        return this.db.prepare(`
            SELECT * FROM change_proposals
            ${where}
            ORDER BY created_at DESC
            LIMIT @limit
        `).all(params).map(row => this._rowToSummary(row));
    }

    async getProposal(proposalId, options = {}) {
        this.initialize();
        const row = this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(String(proposalId));
        if (!row) return null;

        const summary = this._rowToSummary(row);
        if (!options.includeContent) return summary;

        try {
            const [beforeContent, afterContent] = await Promise.all([
                this._readSnapshot(row.before_snapshot),
                this._readSnapshot(row.after_snapshot)
            ]);
            return { ...summary, beforeContent, afterContent };
        } catch (error) {
            return {
                ...summary,
                snapshotReadError: error.message || '快照读取失败。'
            };
        }
    }

    async approveProposal(proposalId, reviewer = 'admin') {
        this.initialize();
        const row = this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(String(proposalId));
        if (!row) throw Object.assign(new Error('Change proposal not found'), { statusCode: 404 });
        if (row.status !== 'pending_approval') {
            throw Object.assign(new Error(`Proposal is already ${row.status}`), { statusCode: 409 });
        }

        this.db.prepare(`
            UPDATE change_proposals
            SET status = 'approved', approval_source = ?, updated_at = ?
            WHERE id = ?
        `).run(`user:${String(reviewer || 'admin')}`, nowIso(), row.id);

        return this._applyProposal(row.id);
    }

    rejectProposal(proposalId, reason = '', reviewer = 'admin') {
        this.initialize();
        const row = this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(String(proposalId));
        if (!row) throw Object.assign(new Error('Change proposal not found'), { statusCode: 404 });
        if (row.status !== 'pending_approval') {
            throw Object.assign(new Error(`Proposal is already ${row.status}`), { statusCode: 409 });
        }

        this.db.prepare(`
            UPDATE change_proposals
            SET status = 'rejected', approval_source = ?, rejection_reason = ?, updated_at = ?
            WHERE id = ?
        `).run(
            `user:${String(reviewer || 'admin')}`,
            String(reason || ''),
            nowIso(),
            row.id
        );
        return this._rowToSummary(this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(row.id));
    }

    async deleteProposal(proposalId) {
        this.initialize();
        const row = this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(String(proposalId));
        if (!row) {
            throw Object.assign(new Error('Change proposal not found'), { statusCode: 404 });
        }
        if (!DELETABLE_STATUSES.has(row.status)) {
            throw Object.assign(
                new Error(`Proposal with status ${row.status} cannot be deleted`),
                { statusCode: 409 }
            );
        }

        await this._removeSnapshot(row.before_snapshot);
        await this._removeSnapshot(row.after_snapshot);
        await this._removeSnapshotDirectory(row.id);
        this.db.prepare('DELETE FROM change_proposals WHERE id = ?').run(row.id);
        return {
            proposalId: row.id,
            status: 'deleted'
        };
    }

    archiveProposal(proposalId, archived = true) {
        this.initialize();
        const row = this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(String(proposalId));
        if (!row) {
            throw Object.assign(new Error('Change proposal not found'), { statusCode: 404 });
        }
        if (!ARCHIVABLE_STATUSES.has(row.status)) {
            throw Object.assign(
                new Error(`Proposal with status ${row.status} cannot be archived`),
                { statusCode: 409 }
            );
        }

        const nextArchived = archived === true;
        this.db.prepare(`
            UPDATE change_proposals
            SET archived = ?, archived_at = ?, updated_at = ?
            WHERE id = ?
        `).run(
            nextArchived ? 1 : 0,
            nextArchived ? nowIso() : null,
            nowIso(),
            row.id
        );
        return this._rowToSummary(this.db.prepare(
            'SELECT * FROM change_proposals WHERE id = ?'
        ).get(row.id));
    }

    async _applyProposal(proposalId) {
        this._markApplyStart();
        try {
            const row = this.db.prepare(
                'SELECT * FROM change_proposals WHERE id = ?'
            ).get(String(proposalId));
            if (!row) throw Object.assign(new Error('Change proposal not found'), { statusCode: 404 });

            const handler = this.applyHandlers.get(row.source_plugin);
            if (typeof handler !== 'function') {
                const error = new Error(`No apply handler registered for ${row.source_plugin}`);
                this.db.prepare(`
                    UPDATE change_proposals
                    SET status = 'failed', error_message = ?, updated_at = ?
                    WHERE id = ?
                `).run(error.message, nowIso(), row.id);
                throw error;
            }

            let beforeContent;
            let afterContent;
            let current;
            try {
                beforeContent = await this._readSnapshot(row.before_snapshot);
                afterContent = await this._readSnapshot(row.after_snapshot);
                current = await this._readCurrentVersion(row.path);
            } catch (error) {
                this.db.prepare(`
                    UPDATE change_proposals
                    SET status = 'failed', error_message = ?, updated_at = ?
                    WHERE id = ?
                `).run(error.message, nowIso(), row.id);
                return this._rowToSummary(this.db.prepare(
                    'SELECT * FROM change_proposals WHERE id = ?'
                ).get(row.id));
            }
            const matchesExpected = row.before_exists === 1
                ? current.exists && current.hash === row.before_hash
                : !current.exists;

            if (!matchesExpected) {
                this.db.prepare(`
                    UPDATE change_proposals
                    SET status = 'stale', error_message = ?, updated_at = ?
                    WHERE id = ?
                `).run('文件在审批后已经发生变化，未执行提案。', nowIso(), row.id);
                return this._rowToSummary(this.db.prepare(
                    'SELECT * FROM change_proposals WHERE id = ?'
                ).get(row.id));
            }

            this.db.prepare(`
                UPDATE change_proposals
                SET status = 'applying', updated_at = ?
                WHERE id = ?
            `).run(nowIso(), row.id);

            try {
                const result = await handler({
                    proposalId: row.id,
                    operationType: row.operation_type,
                    path: row.path,
                    beforeExists: row.before_exists === 1,
                    beforeContent,
                    afterContent,
                    beforeHash: row.before_hash,
                    afterHash: row.after_hash,
                    encoding: row.encoding
                });
                this.db.prepare(`
                    UPDATE change_proposals
                    SET status = 'applied', result_json = ?, error_message = NULL, updated_at = ?
                    WHERE id = ?
                `).run(JSON.stringify(result || null), nowIso(), row.id);
            } catch (error) {
                const conflict = error?.code === 'DAILY_NOTE_WRITE_CONFLICT'
                    || error?.code === 'CHANGE_PROPOSAL_CONFLICT';
                this.db.prepare(`
                    UPDATE change_proposals
                    SET status = ?, error_message = ?, updated_at = ?
                    WHERE id = ?
                `).run(conflict ? 'stale' : 'failed', error.message, nowIso(), row.id);
            }

            return this._rowToSummary(this.db.prepare(
                'SELECT * FROM change_proposals WHERE id = ?'
            ).get(row.id));
        } finally {
            this._markApplyEnd();
        }
    }

    async saveConfig(requireUserApproval) {
        if (typeof requireUserApproval !== 'boolean') {
            throw Object.assign(
                new Error('requireUserApproval must be a boolean'),
                { statusCode: 400 }
            );
        }
        const nextValue = requireUserApproval;

        await this.waitForIdle();
        await updateConfigEnv(this.configPath, nextValue);

        const pluginManager = this.dependencies.pluginManager;
        if (pluginManager && typeof pluginManager.loadPlugins === 'function') {
            await pluginManager.loadPlugins();
        } else {
            this.config.requireUserApproval = nextValue;
        }

        return { requireUserApproval: nextValue };
    }
}

async function updateConfigEnv(configPath, requireUserApproval) {
    let content = '';
    try {
        content = await fsp.readFile(configPath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const lines = content ? content.split(/\r?\n/) : [];
    const keyPattern = /^\s*RequireUserApproval\s*=/i;
    let replaced = false;
    const nextLines = lines.map(line => {
        if (!keyPattern.test(line)) return line;
        replaced = true;
        return `RequireUserApproval=${requireUserApproval ? 'true' : 'false'}`;
    });

    if (!replaced) {
        while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
            nextLines.pop();
        }
        nextLines.push(`RequireUserApproval=${requireUserApproval ? 'true' : 'false'}`);
    }

    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporaryPath, `${nextLines.join('\n')}\n`, 'utf8');
    await fsp.rename(temporaryPath, configPath);
}

function getService() {
    return runtime;
}

function initialize(config = {}, dependencies = {}) {
    if (runtime) {
        runtime.shutdown().catch(error => {
            console.error(`[${PLUGIN_NAME}] Previous runtime shutdown failed:`, error.message);
        });
    }

    const pluginDir = __dirname;
    const stateDir = path.join(pluginDir, 'state');
    runtime = new ChangeProposalService({
        pluginDir,
        stateDir,
        configPath: path.join(pluginDir, 'config.env'),
        config,
        dependencies
    });
    runtime.initialize();
    console.log(
        `[${PLUGIN_NAME}] Initialized. ` +
        `mode=${runtime.getConfig().requireUserApproval ? 'manual' : 'auto'}, ` +
        `state=${stateDir}`
    );
}

function setDependencies(dependencies = {}) {
    if (runtime) runtime.setDependencies(dependencies);
}

function registerRoutes(_app, adminApiRouter, _pluginConfig, _projectBasePath) {
    if (!adminApiRouter || typeof adminApiRouter.get !== 'function') {
        throw new TypeError(`[${PLUGIN_NAME}] adminApiRouter is required`);
    }

    const requireService = res => {
        const service = getService();
        if (!service) {
            res.status(503).json({
                status: 'error',
                error: 'FileChangeApproval service is unavailable.'
            });
            return null;
        }
        service.initialize();
        return service;
    };

    adminApiRouter.get('/change-proposals/config', (req, res) => {
        const service = requireService(res);
        if (!service) return;
        res.json({
            status: 'success',
            config: service.getConfig(),
            service: service.getStatus()
        });
    });

    adminApiRouter.post('/change-proposals/config', async (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const payload = req.body?.config && typeof req.body.config === 'object'
                ? req.body.config
                : req.body;
            const rawValue = payload?.requireUserApproval ?? payload?.RequireUserApproval;
            if (typeof rawValue !== 'boolean') {
                return res.status(400).json({
                    status: 'error',
                    error: 'requireUserApproval must be a boolean.'
                });
            }
            const config = await service.saveConfig(rawValue);
            res.json({
                status: 'success',
                message: '文件变更审批配置已保存并热加载。',
                config
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to save config:`, error);
            res.status(error.statusCode || 500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    adminApiRouter.get('/change-proposals', (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            res.json({
                status: 'success',
                proposals: service.listProposals({
                    status: req.query.status,
                    sourcePlugin: req.query.sourcePlugin || req.query.source_plugin,
                    search: req.query.search || req.query.q,
                    archived: req.query.archived,
                    limit: req.query.limit
                })
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to list proposals:`, error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    adminApiRouter.get('/change-proposals/:proposalId', async (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const proposal = await service.getProposal(
                req.params.proposalId,
                { includeContent: true }
            );
            if (!proposal) {
                return res.status(404).json({
                    status: 'error',
                    error: 'Change proposal not found.'
                });
            }
            res.json({ status: 'success', proposal });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to get proposal:`, error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    adminApiRouter.post('/change-proposals/:proposalId/approve', async (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const proposal = await service.approveProposal(
                req.params.proposalId,
                req.body?.reviewer || 'admin'
            );
            const applied = proposal.status === 'applied';
            res.status(applied ? 200 : 409).json({
                status: applied ? 'success' : 'conflict',
                message: proposal.status === 'stale'
                    ? '文件在审批后已经发生变化，提案未执行。'
                    : proposal.status === 'failed'
                        ? '提案执行失败。'
                        : '文件变更提案已批准并执行。',
                proposal
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to approve proposal:`, error);
            res.status(error.statusCode || 500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    adminApiRouter.post('/change-proposals/:proposalId/reject', (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const proposal = service.rejectProposal(
                req.params.proposalId,
                req.body?.reason || '',
                req.body?.reviewer || 'admin'
            );
            res.json({
                status: 'success',
                message: '文件变更提案已拒绝。',
                proposal
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to reject proposal:`, error);
            res.status(error.statusCode || 500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    adminApiRouter.post('/change-proposals/:proposalId/archive', (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const archived = req.body?.archived !== false;
            const proposal = service.archiveProposal(
                req.params.proposalId,
                archived
            );
            res.json({
                status: 'success',
                message: archived
                    ? '文件变更审批记录已归档。'
                    : '文件变更审批记录已取消归档。',
                proposal
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to archive proposal:`, error);
            res.status(error.statusCode || 500).json({
                status: 'error',
                error: error.message
            });
        }
    });

    adminApiRouter.delete('/change-proposals/:proposalId', async (req, res) => {
        const service = requireService(res);
        if (!service) return;
        try {
            const result = await service.deleteProposal(req.params.proposalId);
            res.json({
                status: 'success',
                message: '文件变更审批记录及其快照已删除。',
                result
            });
        } catch (error) {
            console.error(`[${PLUGIN_NAME}] Failed to delete proposal:`, error);
            res.status(error.statusCode || 500).json({
                status: 'error',
                error: error.message
            });
        }
    });
}

async function shutdown() {
    if (runtime) {
        await runtime.shutdown();
        runtime = null;
    }
}

module.exports = {
    initialize,
    setDependencies,
    registerRoutes,
    getService,
    shutdown,
    ChangeProposalService,
    buildUnifiedDiff
};
