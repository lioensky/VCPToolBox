'use strict';

const path = require('path');

class DatabaseCoordinator {
    constructor(options = {}) {
        if (!options.owner) {
            throw new TypeError('DatabaseCoordinator requires an owner');
        }
        this.owner = options.owner;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async waitForIdle(options = {}) {
        const owner = this.owner;
        const timeoutMs = Math.max(
            1000,
            Number(options.timeoutMs) || 30 * 60 * 1000
        );
        const pollMs = Math.max(10, Number(options.pollMs) || 50);
        const startedAt = Date.now();

        while (
            (!options.allowJsProcessing && owner.isProcessing)
            || (!options.allowJsDeleteProcessing && owner.isProcessingDeletes)
            || (!options.allowExternalMutation && owner.externalMutationActive)
            || owner.rustWriteLease
            || owner.indexRecoveryActive
            || owner.dbHealthState === 'recovering'
        ) {
            if (
                owner.databaseCorruptionDetected
                || owner.dbHealthState === 'corrupt'
            ) {
                throw new Error(
                    'KnowledgeBase database is unavailable because '
                    + 'corruption was detected.'
                );
            }
            if (options.signal?.aborted) {
                const error = new Error(
                    'External file mutation was aborted while waiting '
                    + 'for KnowledgeBase.'
                );
                error.code = 'ABORT_ERR';
                throw error;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(
                    `Timed out waiting for KnowledgeBase coordinator after `
                    + `${timeoutMs}ms (processing=${owner.isProcessing}, `
                    + `deletes=${owner.isProcessingDeletes}, `
                    + `externalMutation=${owner.externalMutationOwner || 'none'}, `
                    + `rustLease=${owner.rustWriteLease?.owner || 'none'}, `
                    + `recovery=${owner.indexRecoveryActive}).`
                );
            }
            await this.delay(pollMs);
        }
    }

    extractMutationPaths(result) {
        const owner = this.owner;
        const upserts = new Set();
        const deletes = new Set();

        const addSafePath = (collection, value) => {
            if (typeof value !== 'string' || !value.trim()) return;
            const resolved = path.resolve(value);
            const relative = path.relative(owner.config.rootPath, resolved);
            if (
                relative
                && !relative.startsWith('..')
                && !path.isAbsolute(relative)
            ) {
                collection.add(resolved);
            }
        };

        const visit = value => {
            if (!value || typeof value !== 'object') return;
            addSafePath(upserts, value.targetFile);
            if (
                typeof value.folder === 'string'
                && typeof value.fileName === 'string'
                && value.folder.trim()
                && value.fileName.trim()
            ) {
                addSafePath(
                    upserts,
                    path.resolve(
                        owner.config.rootPath,
                        value.folder,
                        value.fileName
                    )
                );
            }
            if (
                value.mutationPaths
                && typeof value.mutationPaths === 'object'
            ) {
                for (const filePath of value.mutationPaths.upserts || []) {
                    addSafePath(upserts, filePath);
                }
                for (const filePath of value.mutationPaths.deletes || []) {
                    addSafePath(deletes, filePath);
                }
            }
            if (value.result && typeof value.result === 'object') {
                visit(value.result);
            }
        };

        visit(result);
        return {
            upserts: [...upserts],
            deletes: [...deletes]
        };
    }

    async awaitIndexedFilePaths(filePaths, options = {}) {
        const owner = this.owner;
        if (!Array.isArray(filePaths) || filePaths.length === 0) return;
        const timeoutMs = Math.max(
            1000,
            Number(options.timeoutMs) || 30 * 60 * 1000
        );
        const startedAt = Date.now();

        for (const filePath of filePaths) {
            owner.pendingFiles.add(filePath);
        }
        owner._scheduleBatch();

        while (true) {
            if (
                owner.databaseCorruptionDetected
                || owner.dbHealthState === 'corrupt'
            ) {
                throw new Error(
                    'KnowledgeBase indexing stopped because database '
                    + 'corruption was detected.'
                );
            }
            if (options.signal?.aborted) {
                const error = new Error(
                    'External file mutation was aborted while waiting '
                    + 'for indexing.'
                );
                error.code = 'ABORT_ERR';
                throw error;
            }

            const stillPending = filePaths.some(
                filePath => owner.pendingFiles.has(filePath)
            );
            if (!stillPending && !owner.isProcessing) return;
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(
                    `Timed out waiting for ${filePaths.length} mutated `
                    + 'diary file(s) to be indexed.'
                );
            }
            await this.delay(50);
        }
    }

    async awaitDeletedFilePaths(filePaths, options = {}) {
        const owner = this.owner;
        if (!Array.isArray(filePaths) || filePaths.length === 0) return;
        const timeoutMs = Math.max(
            1000,
            Number(options.timeoutMs) || 30 * 60 * 1000
        );
        const startedAt = Date.now();

        for (const filePath of filePaths) {
            owner.pendingFiles.delete(filePath);
            owner.pendingDeletes.add(filePath);
        }
        owner._scheduleDeleteBatch();

        while (true) {
            if (
                owner.databaseCorruptionDetected
                || owner.dbHealthState === 'corrupt'
            ) {
                throw new Error(
                    'KnowledgeBase deletion stopped because database '
                    + 'corruption was detected.'
                );
            }
            if (options.signal?.aborted) {
                const error = new Error(
                    'External file mutation was aborted while waiting '
                    + 'for deletion indexing.'
                );
                error.code = 'ABORT_ERR';
                throw error;
            }

            const stillPending = filePaths.some(
                filePath => owner.pendingDeletes.has(filePath)
            );
            if (!stillPending && !owner.isProcessingDeletes) return;
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(
                    `Timed out waiting for ${filePaths.length} deleted `
                    + 'diary file(s) to leave the index.'
                );
            }
            await this.delay(50);
        }
    }

    runExternalFileMutation(ownerName, operation, options = {}) {
        const owner = this.owner;
        if (typeof operation !== 'function') {
            return Promise.reject(
                new TypeError('operation must be a function')
            );
        }

        const waitForIndex = options.waitForIndex !== false;
        let resolveFileCommit;
        let rejectFileCommit;
        let fileCommitSettled = false;
        const fileCommitPromise = waitForIndex
            ? null
            : new Promise((resolve, reject) => {
                resolveFileCommit = resolve;
                rejectFileCommit = reject;
            });

        const settleFileCommit = (type, value) => {
            if (waitForIndex || fileCommitSettled) return;
            fileCommitSettled = true;
            if (type === 'resolve') resolveFileCommit(value);
            else rejectFileCommit(value);
        };

        owner.externalMutationQueueLength++;
        const execute = async () => {
            try {
                await this.waitForIdle(options);
                owner.externalMutationActive = true;
                owner.externalMutationOwner = (
                    ownerName || 'external-file-mutation'
                );

                let result;
                try {
                    result = await operation();
                } finally {
                    owner.externalMutationActive = false;
                    owner.externalMutationOwner = null;
                }

                settleFileCommit('resolve', result);
                if (
                    result?.status === 'success'
                    || result?.status === 'partial'
                ) {
                    const mutationPaths = this.extractMutationPaths(result);
                    const indexingOptions = waitForIndex
                        ? options
                        : { ...options, signal: undefined };
                    await this.awaitDeletedFilePaths(
                        mutationPaths.deletes,
                        indexingOptions
                    );
                    await this.awaitIndexedFilePaths(
                        mutationPaths.upserts,
                        indexingOptions
                    );
                }
                return result;
            } catch (error) {
                settleFileCommit('reject', error);
                throw error;
            }
        };

        const task = owner._externalMutationTail.then(execute);
        owner._externalMutationTail = task
            .catch(error => {
                console.error(
                    `[KnowledgeBase] External mutation "${ownerName}" failed:`,
                    error
                );
            })
            .finally(() => {
                owner.externalMutationQueueLength = Math.max(
                    0,
                    owner.externalMutationQueueLength - 1
                );
            });
        return waitForIndex ? task : fileCommitPromise;
    }

    isRustWriteLeaseExpired(now = Date.now()) {
        const owner = this.owner;
        return owner.rustWriteLease
            && now - owner.rustWriteLease.startedAt > (
                owner.rustWriteLease.ttlMs
                || owner.config.rustWriteLeaseTtlMs
            );
    }

    canGrantRustWriteLease(options = {}) {
        const owner = this.owner;
        if (
            owner.databaseCorruptionDetected
            || owner.dbHealthState === 'corrupt'
        ) {
            return { ok: false, reason: 'database-corruption' };
        }
        if (owner.dbHealthState !== 'healthy') {
            return {
                ok: false,
                reason: `database-${owner.dbHealthState}`
            };
        }

        const now = Date.now();
        if (
            owner.startupCompletedAt > 0
            && options.allowDuringStartupCooldown !== true
        ) {
            const sinceStartupReady = now - owner.startupCompletedAt;
            if (
                sinceStartupReady
                < owner.config.derivedStartupCooldownMs
            ) {
                return {
                    ok: false,
                    reason: `startup-cooldown:${
                        owner.config.derivedStartupCooldownMs
                        - sinceStartupReady
                    }ms`
                };
            }
        }

        if (this.isRustWriteLeaseExpired(now)) {
            console.error(
                `[KnowledgeBase] 🚨 Rust write lease `
                + `"${owner.rustWriteLease.owner}" exceeded TTL; `
                + 'force-releasing stale lease.'
            );
            owner.rustWriteLease = null;
            owner.lastRustWriteFinishedAt = now;
        }

        if (owner.rustWriteLease) {
            return {
                ok: false,
                reason: `rust-lease-active:${owner.rustWriteLease.owner}`
            };
        }
        if (owner.externalMutationActive) {
            return {
                ok: false,
                reason: `external-mutation-active:${
                    owner.externalMutationOwner || 'unknown'
                }`
            };
        }
        if (owner.externalMutationQueueLength > 0) {
            return {
                ok: false,
                reason: `external-mutations-queued:${
                    owner.externalMutationQueueLength
                }`
            };
        }
        if (owner.isProcessing) {
            return { ok: false, reason: 'js-batch-processing' };
        }
        if (owner.isProcessingDeletes) {
            return { ok: false, reason: 'js-delete-processing' };
        }
        if (owner.pendingDeletes.size > 0) {
            return {
                ok: false,
                reason: `pending-deletes:${owner.pendingDeletes.size}`
            };
        }

        const threshold = options.pendingThreshold
            ?? owner.config.rustWriteLeasePendingThreshold;
        if (
            threshold >= 0
            && owner.pendingFiles.size > threshold
        ) {
            return {
                ok: false,
                reason: `pending-files:${owner.pendingFiles.size}>${threshold}`
            };
        }

        const graceMs = options.graceMs
            ?? owner.config.rustWriteLeaseGraceMs;
        const sinceJsWrite = now - owner.lastJsWriteFinishedAt;
        if (
            owner.lastJsWriteFinishedAt > 0
            && sinceJsWrite < graceMs
        ) {
            return {
                ok: false,
                reason: `js-write-cooldown:${graceMs - sinceJsWrite}ms`
            };
        }

        const sinceRustWrite = now - owner.lastRustWriteFinishedAt;
        if (
            owner.lastRustWriteFinishedAt > 0
            && sinceRustWrite < owner.config.rustWriteLeaseCooldownMs
        ) {
            return {
                ok: false,
                reason: `rust-write-cooldown:${
                    owner.config.rustWriteLeaseCooldownMs - sinceRustWrite
                }ms`
            };
        }
        return { ok: true, reason: 'ok' };
    }

    async requestRustWriteLease(ownerName, options = {}) {
        const owner = this.owner;
        const startedWaitAt = Date.now();
        const retryMs = options.retryMs
            ?? owner.config.rustWriteLeaseRetryMs;
        const maxWaitMs = options.maxWaitMs
            ?? owner.config.rustWriteLeaseMaxWaitMs;
        const ttlMs = options.ttlMs
            ?? owner.config.rustWriteLeaseTtlMs;

        while (true) {
            const decision = this.canGrantRustWriteLease(options);
            if (decision.ok) {
                if (owner.config.rustWriteLeaseCheckpointBeforeGrant) {
                    const healthy = (
                        owner.checkpointAndAssertDatabaseHealthy(
                            `granting Rust lease "${ownerName}"`
                        )
                    );
                    if (!healthy) {
                        console.error(
                            `[KnowledgeBase] 🦀🚫 Rust SQLite write lease `
                            + `"${ownerName}" denied because database health `
                            + 'check failed.'
                        );
                        return null;
                    }
                }

                owner.rustWriteLease = {
                    owner: ownerName,
                    startedAt: Date.now(),
                    ttlMs
                };
                console.log(
                    `[KnowledgeBase] 🦀🔐 Rust SQLite write lease granted `
                    + `to "${ownerName}".`
                );
                return {
                    owner: ownerName,
                    release: () => this.releaseRustWriteLease(ownerName)
                };
            }

            if (Date.now() - startedWaitAt >= maxWaitMs) {
                console.warn(
                    `[KnowledgeBase] 🦀⏳ Rust SQLite write lease `
                    + `"${ownerName}" timed out after ${maxWaitMs}ms; `
                    + `last reason=${decision.reason}.`
                );
                return null;
            }

            const now = Date.now();
            if (now - owner._rustLeaseWaitLogAt > 30000) {
                owner._rustLeaseWaitLogAt = now;
                console.log(
                    `[KnowledgeBase] 🦀⏳ Rust SQLite write lease `
                    + `"${ownerName}" waiting: ${decision.reason}. `
                    + `pendingFiles=${owner.pendingFiles.size}, `
                    + `pendingDeletes=${owner.pendingDeletes.size}`
                );
            }
            await this.delay(retryMs);
        }
    }

    releaseRustWriteLease(ownerName) {
        const owner = this.owner;
        if (!owner.rustWriteLease) return;
        if (owner.rustWriteLease.owner !== ownerName) {
            console.warn(
                `[KnowledgeBase] ⚠️ Ignored Rust write lease release from `
                + `"${ownerName}"; active owner is `
                + `"${owner.rustWriteLease.owner}".`
            );
            return;
        }

        owner.rustWriteLease = null;
        owner.lastRustWriteFinishedAt = Date.now();
        console.log(
            `[KnowledgeBase] 🦀🔓 Rust SQLite write lease released by `
            + `"${ownerName}".`
        );

        if (!owner.databaseCorruptionDetected) {
            if (owner.pendingDeletes.size > 0) {
                setTimeout(
                    () => owner._flushDeleteBatch(),
                    owner.config.rustWriteLeaseCooldownMs
                );
            }
            if (owner.pendingFiles.size > 0) {
                setTimeout(
                    () => owner._flushBatch(),
                    owner.config.rustWriteLeaseCooldownMs
                );
            }
        }
    }

    deferBatchForRustLease(type = 'batch') {
        const owner = this.owner;
        const leaseOwner = owner.rustWriteLease?.owner || 'unknown';
        const delay = owner.config.rustWriteLeaseCooldownMs;
        console.log(
            `[KnowledgeBase] 🦀⏸️ Deferring ${type} while Rust SQLite `
            + `write lease is active (${leaseOwner}).`
        );
        setTimeout(() => {
            if (type === 'delete') owner._flushDeleteBatch();
            else owner._flushBatch();
        }, delay);
    }

    async waitForExternalMutations() {
        await this.owner._externalMutationTail;
    }
}

module.exports = DatabaseCoordinator;