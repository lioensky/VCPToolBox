// modules/tvsManager.js
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');

function resolveTvsDir() {
    const configPath = process.env.TVS_DIR_PATH;
    if (!configPath || typeof configPath !== 'string' || configPath.trim() === '') {
        return path.join(__dirname, '..', 'TVStxt');
    }

    const normalizedPath = path.normalize(configPath.trim());
    return path.isAbsolute(normalizedPath)
        ? normalizedPath
        : path.resolve(__dirname, '..', normalizedPath);
}

class TvsManager {
    constructor() {
        this.contentCache = new Map();
        this.debugMode = false;
        this.tvsDir = resolveTvsDir();
    }

    initialize(debugMode = false) {
        this.debugMode = debugMode;
        this.tvsDir = resolveTvsDir();
        console.log(`[TvsManager] Initializing... TVS directory: ${this.tvsDir}`);
        fs.mkdir(this.tvsDir, { recursive: true })
            .then(() => this.watchFiles())
            .catch((error) => {
                console.error(`[TvsManager] Failed to ensure TVS directory: ${this.tvsDir}`, error);
            });
    }

    watchFiles() {
        try {
            const watcher = chokidar.watch(this.tvsDir, {
                ignored: /(^|[\/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: true, // Don't trigger 'add' events on startup
            });

            watcher
                .on('change', (filePath) => {
                    const filename = path.basename(filePath);
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename);
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file change.`);
                    }
                })
                .on('unlink', (filePath) => {
                    const filename = path.basename(filePath);
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename);
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file deletion.`);
                    }
                })
                .on('error', (error) => console.error(`[TvsManager] Watcher error: ${error}`));

            if (this.debugMode) {
                console.log(`[TvsManager] Watching for changes in: ${this.tvsDir}`);
            }
        } catch (error) {
            console.error(`[TvsManager] Failed to set up file watcher:`, error);
        }
    }

    async getContent(filename) {
        if (this.contentCache.has(filename)) {
            if (this.debugMode) {
                console.log(`[TvsManager] Cache hit for '${filename}'.`);
            }
            return this.contentCache.get(filename);
        }

        if (this.debugMode) {
            console.log(`[TvsManager] Cache miss for '${filename}'. Reading from disk.`);
        }

        try {
            const filePath = path.join(this.tvsDir, filename);
            const content = await fs.readFile(filePath, 'utf8');
            this.contentCache.set(filename, content);
            return content;
        } catch (error) {
            // Don't cache errors, so it can be retried if the file appears later.
            console.error(`[TvsManager] Error reading file '${filename}':`, error.message);
            if (error.code === 'ENOENT') {
                return `[变量文件 (${filename}) 未找到]`;
            }
            return `[处理变量文件 (${filename}) 时出错]`;
        }
    }
}

const tvsManager = new TvsManager();
module.exports = tvsManager;