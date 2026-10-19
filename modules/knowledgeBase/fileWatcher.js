'use strict';

const path = require('path');

class KnowledgeBaseFileWatcher {
    constructor(options = {}) {
        if (!options.owner) {
            throw new TypeError('KnowledgeBaseFileWatcher requires an owner');
        }
        this.owner = options.owner;
        this.watcher = null;
        this.watcherType = null;
        this.eventPoller = null;
        this.reconcileInFlight = false;
        this.reconcileQueued = false;
        this.lifecycleGeneration = 0;
    }

    _isIgnored(diaryName, fileName = '') {
        const config = this.owner.config;
        if (config.ignoreFolders.includes(diaryName)) return true;
        if (
            config.ignorePrefixes.some(
                prefix => diaryName.startsWith(prefix)
                    || fileName.startsWith(prefix)
            )
        ) {
            return true;
        }
        return config.ignoreSuffixes.some(
            suffix => diaryName.endsWith(suffix)
                || fileName.endsWith(suffix)
        );
    }

    _queueFile(filePath) {
        const owner = this.owner;
        owner.pendingFiles.add(filePath);
        if (owner.pendingFiles.size >= owner.config.maxBatchSize) {
            owner._flushBatch();
        } else {
            owner._scheduleBatch();
        }
    }

    _queueDelete(filePath) {
        const owner = this.owner;
        owner.pendingFiles.delete(filePath);
        owner._queueDelete(filePath);
    }

    _handleRustEvent(...args) {
        const owner = this.owner;
        try {
            const jsonPayload = args.find(
                argument => argument && typeof argument === 'object'
            ) || args.find(argument => typeof argument === 'string');
            if (!jsonPayload) {
                console.warn(
                    '[KnowledgeBase] Ignored Rust watcher callback without '
                    + 'string payload:',
                    args
                );
                return;
            }

            const payload = typeof jsonPayload === 'string'
                ? JSON.parse(jsonPayload) : jsonPayload;
            const { event, path: filePath } = payload;
            if (event === 'overflow') {
                this._reconcileAfterOverflow();
                return;
            }
            if (!filePath || typeof filePath !== 'string') {
                console.warn(
                    '[KnowledgeBase] Ignored Rust watcher event without '
                    + 'a valid path:',
                    payload
                );
                return;
            }

            const generation = Number(payload.generation);
            const hasStableProtocol = payload.stable === true
                && Number.isSafeInteger(generation)
                && generation > 0;
            const normalizedPath = path.resolve(filePath);

            if (hasStableProtocol) {
                const lastGeneration = (
                    owner.watcherPathGenerations.get(normalizedPath) || 0
                );
                if (generation <= lastGeneration) {
                    owner.staleWatcherEventsDropped++;
                    if (owner.debugMode) {
                        console.log(
                            `[KnowledgeBase] Dropped stale watcher event: `
                            + `path=${normalizedPath}, `
                            + `generation=${generation}, `
                            + `latest=${lastGeneration}`
                        );
                    }
                    return;
                }
                owner.watcherPathGenerations.set(
                    normalizedPath,
                    generation
                );
            }

            if (event === 'unlink' && hasStableProtocol) {
                this._queueDelete(normalizedPath);
            } else if (event === 'add' || event === 'change') {
                owner.pendingDeletes.delete(normalizedPath);
                if (hasStableProtocol) {
                    this._queueFile(normalizedPath);
                } else {
                    console.warn(
                        '[KnowledgeBase] Ignoring non-native unstable watcher event:',
                        normalizedPath
                    );
                }
            }
        } catch (error) {
            console.error(
                '[KnowledgeBase] Failed to parse Rust watcher event:',
                error
            );
        }
    }

    async _reconcileAfterOverflow() {
        const runtime = this.owner.nativeKnowledgeRuntime;
        const listIndexedFilePaths = runtime?.listIndexedFilePaths
            || runtime?.list_indexed_file_paths;
        const reconcileWithPaths = runtime?.reconcileWatchWithPaths
            || runtime?.reconcile_watch_with_paths;
        const fallbackReconcile = runtime?.reconcileWatch
            || runtime?.reconcile_watch;

        if (
            typeof listIndexedFilePaths !== 'function'
            || typeof reconcileWithPaths !== 'function'
        ) {
            if (typeof fallbackReconcile !== 'function') {
                console.error(
                    '[KnowledgeBase] Rust watcher queue overflowed, but ' +
                    'reconciliation ABI is unavailable; rebuild rust-vexus-lite.'
                );
                return;
            }
            try {
                fallbackReconcile.call(runtime);
            } catch (error) {
                console.error(
                    '[KnowledgeBase] Failed to request fallback Rust watcher reconciliation:',
                    error
                );
            }
            return;
        }

        if (this.reconcileInFlight) {
            this.reconcileQueued = true;
            return;
        }

        this.reconcileInFlight = true;
        const lifecycleGeneration = this.lifecycleGeneration;
        try {
            const rawPaths = await listIndexedFilePaths.call(
                runtime,
                this.owner.dbPath
            );
            if (
                lifecycleGeneration !== this.lifecycleGeneration
                || this.watcher !== runtime
            ) return;
            const indexedPaths = typeof rawPaths === 'string'
                ? JSON.parse(rawPaths)
                : rawPaths;
            const paths = [...new Set(
                (Array.isArray(indexedPaths) ? indexedPaths : [])
                    .map(value => String(value || '').trim())
                    .filter(Boolean)
            )];

            reconcileWithPaths.call(runtime, paths);
            if (this.owner.debugMode) {
                console.warn(
                    '[KnowledgeBase] Rust watcher queue overflowed; ' +
                    `native reconciliation requested with ${paths.length} indexed path(s).`
                );
            }
        } catch (error) {
            console.error(
                '[KnowledgeBase] Failed to reconcile Rust watcher after queue overflow:',
                error
            );
        } finally {
            if (lifecycleGeneration !== this.lifecycleGeneration) return;
            this.reconcileInFlight = false;
            if (this.reconcileQueued) {
                this.reconcileQueued = false;
                void this._reconcileAfterOverflow();
            }
        }
    }

    _drainRustEvents() {
        const runtime = this.owner.nativeKnowledgeRuntime;
        const drainEvents = runtime?.drainWatchEvents
            || runtime?.drain_watch_events;
        if (!runtime || typeof drainEvents !== 'function') return;

        let events;
        try {
            events = drainEvents.call(runtime, 256) || [];
        } catch (error) {
            if (this.owner.debugMode) {
                console.warn(
                    '[KnowledgeBase] Failed to drain Rust watcher events:',
                    error
                );
            }
            return;
        }

        for (const event of events) {
            this._handleRustEvent(event);
        }
    }

    _startRustWatcher() {
        const runtime = this.owner.nativeKnowledgeRuntime;
        const startWatch = runtime?.startWatch
            || runtime?.start_watch;
        const drainEvents = runtime?.drainWatchEvents
            || runtime?.drain_watch_events;
        if (
            !runtime
            || typeof startWatch !== 'function'
            || typeof drainEvents !== 'function'
        ) {
            throw new Error(
                'NativeKnowledgeRuntime watcher queue ABI is unavailable; '
                + 'rebuild rust-vexus-lite'
            );
        }

        const config = this.owner.config;
        startWatch.call(runtime, {
            rootPath: config.rootPath,
            ignoreFolders: config.ignoreFolders || [],
            ignorePrefixes: config.ignorePrefixes || [],
            ignoreSuffixes: config.ignoreSuffixes || [],
            // Startup uses the single reconciliation below, including indexed
            // paths for missing-file detection. Do not also launch a native scan.
            initialScan: false,
            debounceMs: parseInt(
                process.env.KNOWLEDGEBASE_WATCH_DEBOUNCE_MS,
                10
            ) || 350,
            stabilityMs: parseInt(
                process.env.KNOWLEDGEBASE_WATCH_STABILITY_MS,
                10
            ) || 150,
            stabilityRetries: parseInt(
                process.env.KNOWLEDGEBASE_WATCH_STABILITY_RETRIES,
                10
            ) || 6
        });

        // JS 只保留轻量生命周期投影；实际 watcher、notify 句柄、
        // 稳定性判断、初始对账和有界事件队列归 Runtime 所有。
        this.watcher = runtime;
        this.watcherType = 'runtime-owned-rust';
        this.eventPoller = setInterval(
            () => this._drainRustEvents(),
            100
        );
        this.eventPoller.unref?.();
        this._drainRustEvents();
        this._publishState();
        // One authoritative startup scan, with the indexed-path snapshot.
        // Real overflow recovery remains independently enabled.
        if (config.fullScanOnStartup !== false) {
            void this._reconcileAfterOverflow();
        }
        console.log(
            '[KnowledgeBase] Using Runtime-owned Rust watcher; ' +
            `startup scan=${config.fullScanOnStartup !== false ? 'enabled' : 'disabled'}, ` +
            'overflow recovery=enabled.'
        );
        return this.watcher;
    }

    _publishState() {
        this.owner.watcher = this.watcher;
        this.owner.watcherType = this.watcherType;
    }

    start() {
        if (this.watcher) return this.watcher;
        this.lifecycleGeneration++;
        return this._startRustWatcher();
    }

    async stop() {
        this.lifecycleGeneration++;
        if (this.eventPoller) {
            clearInterval(this.eventPoller);
            this.eventPoller = null;
        }
        if (!this.watcher) return;
        if (this.watcherType === 'runtime-owned-rust') {
            const stopWatch = this.watcher.stopWatch
                || this.watcher.stop_watch;
            if (typeof stopWatch === 'function') {
                stopWatch.call(this.watcher);
            }
        } else if (typeof this.watcher.close === 'function') {
            await this.watcher.close();
        }
        this.watcher = null;
        this.watcherType = null;
        this.reconcileInFlight = false;
        this.reconcileQueued = false;
        this._publishState();
        this.owner.watcherPathGenerations.clear();
    }
}

module.exports = KnowledgeBaseFileWatcher;