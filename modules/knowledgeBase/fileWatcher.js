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
                argument => typeof argument === 'string'
            );
            if (!jsonPayload) {
                console.warn(
                    '[KnowledgeBase] Ignored Rust watcher callback without '
                    + 'string payload:',
                    args
                );
                return;
            }

            const payload = JSON.parse(jsonPayload);
            const { event, path: filePath } = payload;
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

            if (event === 'unlink') {
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
            this._handleRustEvent(JSON.stringify(event));
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
        this._drainRustEvents();
        this._publishState();
        console.log(
            '[KnowledgeBase] Using Runtime-owned Rust watcher; ' +
            'initial reconciliation is native.'
        );
        return this.watcher;
    }

    _publishState() {
        this.owner.watcher = this.watcher;
        this.owner.watcherType = this.watcherType;
    }

    start() {
        if (this.watcher) return this.watcher;
        return this._startRustWatcher();
    }

    async stop() {
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
        this._publishState();
        this.owner.watcherPathGenerations.clear();
    }
}

module.exports = KnowledgeBaseFileWatcher;