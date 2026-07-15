'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chokidar = require('chokidar');

class KnowledgeBaseFileWatcher {
    constructor(options = {}) {
        if (!options.owner) {
            throw new TypeError('KnowledgeBaseFileWatcher requires an owner');
        }
        this.owner = options.owner;
        this.VexusIndex = options.VexusIndex;
        this.loadVexusModule = options.loadVexusModule;
        this.watcher = null;
        this.watcherType = null;
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

    _scanInitialFiles() {
        const owner = this.owner;
        const config = owner.config;
        if (!config.fullScanOnStartup) return;

        let queued = 0;
        const walk = directory => {
            let entries;
            try {
                entries = fsSync.readdirSync(directory, {
                    withFileTypes: true
                });
            } catch (error) {
                console.warn(
                    `[KnowledgeBase] Initial scan skipped unreadable `
                    + `directory "${directory}": ${error.message}`
                );
                return;
            }

            for (const entry of entries) {
                const absolutePath = path.join(directory, entry.name);
                const relativePath = path.relative(
                    config.rootPath,
                    absolutePath
                );
                const parts = relativePath.split(path.sep);
                const diaryName = parts.length > 1 ? parts[0] : 'Root';

                if (entry.isDirectory()) {
                    if (
                        ['node_modules', '.git', 'dist', 'target', 'image']
                            .includes(entry.name)
                        || entry.name.startsWith('.')
                        || config.ignoreFolders.includes(entry.name)
                        || this._isIgnored(diaryName, entry.name)
                    ) {
                        continue;
                    }
                    walk(absolutePath);
                    continue;
                }

                if (!entry.isFile() || !/\.(md|txt)$/i.test(absolutePath)) {
                    continue;
                }
                if (this._isIgnored(diaryName, entry.name)) continue;
                this._queueFile(absolutePath);
                queued++;
            }
        };

        walk(config.rootPath);
        console.log(
            queued > 0
                ? `[KnowledgeBase] 🔍 Initial full scan queued ${queued} file(s).`
                : '[KnowledgeBase] 🔍 Initial full scan found no indexable files.'
        );
    }

    async _handleFileWithStabilityCheck(filePath) {
        try {
            const first = await fs.stat(filePath);
            await new Promise(resolve => setTimeout(resolve, 500));
            const second = await fs.stat(filePath);
            if (
                first.size === second.size
                && first.mtimeMs === second.mtimeMs
            ) {
                this._queueFile(filePath);
            } else {
                setTimeout(
                    () => this._handleFileWithStabilityCheck(filePath),
                    1000
                );
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(
                    '[KnowledgeBase] Stability check error:',
                    error.message
                );
            }
        }
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
                    this._handleFileWithStabilityCheck(normalizedPath);
                }
            }
        } catch (error) {
            console.error(
                '[KnowledgeBase] Failed to parse Rust watcher event:',
                error
            );
        }
    }

    _tryStartRustWatcher() {
        if (
            !this.VexusIndex
            || !this.VexusIndex.prototype
            || typeof this.VexusIndex.prototype.start_watch !== 'undefined'
        ) {
            return false;
        }

        try {
            const vexusModule = this.loadVexusModule();
            if (!vexusModule.VexusWatcher) return false;
            const rustWatcher = new vexusModule.VexusWatcher();
            const startWatch = rustWatcher.startWatch
                || rustWatcher.start_watch;
            if (typeof startWatch !== 'function') {
                throw new Error(
                    'VexusWatcher startWatch/start_watch method not found'
                );
            }

            const config = this.owner.config;
            startWatch.call(rustWatcher, {
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
            }, (...args) => this._handleRustEvent(...args));

            this.watcher = rustWatcher;
            this.watcherType = 'rust';
            this._publishState();
            console.log('[KnowledgeBase] 🦀 Using Rust native watcher.');
            this._scanInitialFiles();
            return true;
        } catch (error) {
            console.warn(
                '[KnowledgeBase] ⚠️ Failed to initialize Rust Watcher, '
                + `falling back to Chokidar: ${error.message}`
            );
            return false;
        }
    }

    _startChokidarWatcher() {
        const owner = this.owner;
        const config = owner.config;
        console.log('[KnowledgeBase] 🔄 Using Chokidar watcher fallback...');

        const handleFile = filePath => {
            const relativePath = path.relative(config.rootPath, filePath);
            const parts = relativePath.split(path.sep);
            const diaryName = parts.length > 1 ? parts[0] : 'Root';
            const fileName = path.basename(relativePath);
            if (
                this._isIgnored(diaryName, fileName)
                || !/\.(md|txt)$/i.test(filePath)
            ) {
                return;
            }
            this._handleFileWithStabilityCheck(filePath);
        };

        const ignoredPatterns = [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/target/**',
            '**/image/**',
            '**/.*'
        ];
        for (const folder of config.ignoreFolders || []) {
            if (folder) ignoredPatterns.push(`**/${folder}/**`);
        }

        this.watcher = chokidar.watch(config.rootPath, {
            ignored: ignoredPatterns,
            ignoreInitial: !config.fullScanOnStartup
        });
        this.watcher
            .on('add', handleFile)
            .on('change', handleFile)
            .on('unlink', filePath => this._queueDelete(filePath));
        this.watcherType = 'chokidar';
        this._publishState();
    }

    _publishState() {
        this.owner.watcher = this.watcher;
        this.owner.watcherType = this.watcherType;
    }

    start() {
        if (this.watcher) return this.watcher;
        if (!this._tryStartRustWatcher()) {
            this._startChokidarWatcher();
        }
        return this.watcher;
    }

    async stop() {
        if (!this.watcher) return;
        if (this.watcherType === 'rust') {
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