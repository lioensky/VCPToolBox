'use strict';

const path = require('path');

class DatabaseCoordinator {
    constructor(options = {}) {
        if (!options.owner) {
            throw new TypeError('DatabaseCoordinator requires an owner');
        }
        this.owner = options.owner;
        this.pathWaiters = new Map();
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _normalizePath(filePath) {
        return path.resolve(String(filePath || ''));
    }

    _settlePathWaiters(filePaths, kind, error = null) {
        const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
        for (const filePath of paths) {
            const normalizedPath = this._normalizePath(filePath);
            const waiters = this.pathWaiters.get(normalizedPath);
            if (!waiters || waiters.size === 0) continue;
            for (const waiter of waiters) {
                if (waiter.kind !== kind) continue;
                if (error) waiter.reject(error);
                else waiter.resolve();
                // 多路径共享超时，只在整组完成或失败时清理。
            }
            const remaining = new Set(
                [...waiters].filter(waiter => waiter.kind !== kind)
            );
            if (remaining.size > 0) this.pathWaiters.set(normalizedPath, remaining);
            else this.pathWaiters.delete(normalizedPath);
        }
    }

    notifyIndexedFilePaths(filePaths, error = null) {
        this._settlePathWaiters(filePaths, 'indexed', error);
    }

    notifyDeletedFilePaths(filePaths, error = null) {
        this._settlePathWaiters(filePaths, 'deleted', error);
    }

    _waitForPathReceipts(filePaths, kind, options = {}) {
        const normalizedPaths = [...new Set(
            (Array.isArray(filePaths) ? filePaths : [filePaths])
                .map(filePath => this._normalizePath(filePath))
                .filter(Boolean)
        )];
        if (normalizedPaths.length === 0) return Promise.resolve();

        const timeoutMs = Math.max(
            1000,
            Number(options.timeoutMs) || 30 * 60 * 1000
        );
        const signal = options.signal;
        return new Promise((resolve, reject) => {
            const waiters = [];
            let onAbort;
            const cleanup = () => {
                clearTimeout(timer);
                if (onAbort) signal?.removeEventListener?.('abort', onAbort);
                for (const [normalizedPath, waiter] of waiters) {
                    const entries = this.pathWaiters.get(normalizedPath);
                    if (!entries) continue;
                    entries.delete(waiter);
                    if (entries.size === 0) this.pathWaiters.delete(normalizedPath);
                }
            };
            const fail = error => {
                cleanup();
                reject(error);
            };
            const timer = setTimeout(() => {
                const error = new Error(
                    `Timed out waiting for ${normalizedPaths.length} ${kind} receipt(s).`
                );
                error.code = 'KNOWLEDGE_STORE_RECEIPT_TIMEOUT';
                fail(error);
            }, timeoutMs);

            for (const normalizedPath of normalizedPaths) {
                const waiter = {
                    kind,
                    resolve: () => {},
                    reject: fail,
                    timer
                };
                waiters.push([normalizedPath, waiter]);
                if (!this.pathWaiters.has(normalizedPath)) {
                    this.pathWaiters.set(normalizedPath, new Set());
                }
                this.pathWaiters.get(normalizedPath).add(waiter);
            }

            let remaining = normalizedPaths.length;
            const completeOne = () => {
                remaining -= 1;
                if (remaining > 0) return;
                clearTimeout(timer);
                cleanup();
                resolve();
            };
            for (const [, waiter] of waiters) {
                waiter.resolve = completeOne;
            }

            if (signal) {
                if (signal.aborted) {
                    const error = new Error(
                        'External file mutation was aborted while waiting for a receipt.'
                    );
                    error.code = 'ABORT_ERR';
                    fail(error);
                    return;
                }
                onAbort = () => {
                    signal.removeEventListener?.('abort', onAbort);
                    const error = new Error(
                        'External file mutation was aborted while waiting for a receipt.'
                    );
                    error.code = 'ABORT_ERR';
                    fail(error);
                };
                signal.addEventListener?.('abort', onAbort, { once: true });
                for (const [, waiter] of waiters) waiter.onAbort = onAbort;
            }
        });
    }

    async waitForIdle(options = {}) {
        const owner = this.owner;
        const timeoutMs = Math.max(
            1000,
            Number(options.timeoutMs) || 30 * 60 * 1000
        );
        const rawStall = Number(options.stallThresholdMs);
        const stallThresholdMs = Number.isFinite(rawStall) && rawStall > 0
            ? Math.max(10, Math.floor(rawStall))
            : 120 * 1000;
        const pollMs = Math.max(10, Number(options.pollMs) || 50);
        const startedAt = Date.now();

        if (
            owner.databaseCorruptionDetected
            || owner.dbHealthState === 'corrupt'
        ) {
            throw new Error(
                'KnowledgeBase database is unavailable because '
                + 'corruption was detected.'
            );
        }
        while (
            (!options.allowJsProcessing && owner.isProcessing)
            || (!options.allowJsDeleteProcessing && owner.isProcessingDeletes)
            || (!options.allowExternalMutation && owner.externalMutationActive)
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
            const lastActive = Math.max(
                startedAt,
                Number(owner.lastActivityAt) || 0
            );
            const timeSinceLastActivity = Date.now() - lastActive;
            const isStalled = timeSinceLastActivity >= stallThresholdMs;
            const isAbsoluteTimeout = (Date.now() - startedAt) >= timeoutMs;

            if (isStalled || isAbsoluteTimeout) {
                const reason = isStalled
                    ? `activity stalled with zero progress for ${Math.round(timeSinceLastActivity / 1000)}s`
                    : `reached absolute limit of ${Math.round(timeoutMs / 1000)}s`;
                throw new Error(
                    `Timed out waiting for KnowledgeBase coordinator after `
                    + `${Date.now() - startedAt}ms (${reason}) (processing=${owner.isProcessing}, `
                    + `deletes=${owner.isProcessingDeletes}, `
                    + `externalMutation=${owner.externalMutationOwner || 'none'}, `
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
        const receiptPromise = this._waitForPathReceipts(
            filePaths,
            'indexed',
            options
        );
        for (const filePath of filePaths) {
            owner.pendingFiles.add(filePath);
        }
        owner._scheduleBatch();
        return receiptPromise;
    }

    async awaitDeletedFilePaths(filePaths, options = {}) {
        const owner = this.owner;
        if (!Array.isArray(filePaths) || filePaths.length === 0) return;
        const receiptPromise = this._waitForPathReceipts(
            filePaths,
            'deleted',
            options
        );
        for (const filePath of filePaths) {
            owner.pendingFiles.delete(filePath);
            owner.pendingDeletes.add(filePath);
        }
        owner._scheduleDeleteBatch();
        return receiptPromise;
    }

    runExternalFileMutation(ownerName, operation, options = {}) {
        const owner = this.owner;
        if (typeof operation !== 'function') {
            return Promise.reject(
                new TypeError('operation must be a function')
            );
        }

        const waitForIndex = options.waitForIndex !== false;

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

                if (
                    result?.status === 'success'
                    || result?.status === 'partial'
                ) {
                    const mutationPaths = this.extractMutationPaths(result);
                    if (waitForIndex) {
                        await this.awaitDeletedFilePaths(
                            mutationPaths.deletes,
                            options
                        );
                        await this.awaitIndexedFilePaths(
                            mutationPaths.upserts,
                            options
                        );
                    } else {
                        // 最终一致模式只负责把路径交给现有批处理器，不在外部变更
                        // FIFO 中等待 Embedding/SQLite/Vexus。这样后续日记可以继续
                        // 落盘，并在同一个收集窗口内合并为批量索引任务。
                        for (const filePath of mutationPaths.deletes) {
                            owner.pendingFiles.delete(filePath);
                            owner.pendingDeletes.add(filePath);
                        }
                        for (const filePath of mutationPaths.upserts) {
                            owner.pendingDeletes.delete(filePath);
                            owner.pendingFiles.add(filePath);
                        }
                        if (mutationPaths.deletes.length > 0) {
                            owner._scheduleDeleteBatch();
                        }
                        if (mutationPaths.upserts.length > 0) {
                            owner._scheduleBatch();
                        }
                    }
                }
                return result;
            } catch (error) {
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

                // 收集窗口可能在长耗时 update/organize 执行期间到期。
                // 等当前已排队的外部文件操作全部提交后只补刷一次，既不会
                // 丢失索引任务，也不会让索引插到同一轮多文件写入之间。
                if (owner.externalMutationQueueLength === 0) {
                    const flushDeletes = owner.externalMutationDeleteBatchDeferred;
                    const flushUpserts = owner.externalMutationBatchDeferred;
                    owner.externalMutationDeleteBatchDeferred = false;
                    owner.externalMutationBatchDeferred = false;

                    if (flushDeletes || flushUpserts) {
                        setImmediate(() => {
                            if (flushDeletes && owner.pendingDeletes.size > 0) {
                                owner._flushDeleteBatch();
                            }
                            if (flushUpserts && owner.pendingFiles.size > 0) {
                                owner._flushBatch();
                            }
                        });
                    }
                }
            });
        return task;
    }

    async waitForExternalMutations() {
        await this.owner._externalMutationTail;
    }
}

module.exports = DatabaseCoordinator;