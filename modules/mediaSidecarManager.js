// modules/mediaSidecarManager.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { EventEmitter } = require('events');

const DEFAULT_SUPPORTED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif', '.svg',
    '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg',
    '.mp4', '.mov', '.mkv', '.webm', '.avi',
    '.pdf'
]);

class MediaSidecarManager extends EventEmitter {
    constructor() {
        super();
        this.watcher = null;
        this.initialized = false;
        this.debugMode = false;
        this.config = {
            rootPath: '',
            storePath: '',
            sidecarSuffix: process.env.MULTIMODAL_SIDECAR_SUFFIX || '.vcpmeta.json',
            enable: (process.env.MULTIMODAL_SIDECAR_ENABLED || 'false').toLowerCase() === 'true',
            sidecarCreateDelayMs: parseInt(process.env.MULTIMODAL_SIDECAR_CREATE_DELAY_MS || '1000', 10),
            metadataSyncEnabled: (process.env.MEDIA_METADATA_SYNC || 'false').toLowerCase() === 'true'
        };

        this.hashMapPath = '';
        this.hashMap = new Map();
        this.pendingTimers = new Map();
        this.pendingDeleteTimers = new Map();
    }

    async initialize(options = {}) {
        if (this.initialized) return;

        this.debugMode = !!options.debugMode;
        this.config.rootPath = options.rootPath || process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(__dirname, '..', 'dailynote');
        this.config.storePath = options.storePath || process.env.KNOWLEDGEBASE_STORE_PATH || path.join(__dirname, '..', 'VectorStore');

        this.hashMapPath = path.join(this.config.storePath, 'media_hash_map.json');

        if (!this.config.enable) {
            this._log('disabled by env flag.');
            this.initialized = true;
            return;
        }

        await fs.mkdir(this.config.storePath, { recursive: true });
        await this._loadHashMap();
        this._startWatcher();

        this.initialized = true;
        this._log(`initialized. root=${this.config.rootPath}`);
    }

    async shutdown() {
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();

        for (const timer of this.pendingDeleteTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingDeleteTimers.clear();

        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }

        await this._saveHashMap();
        this.initialized = false;
    }

    isEnabled() {
        return this.config.enable;
    }

    _log(message) {
        if (this.debugMode) {
            console.log(`[MediaSidecarManager] ${message}`);
        }
    }

    _isSidecarFile(filePath) {
        return filePath.endsWith(this.config.sidecarSuffix);
    }

    _isDotPath(filePath) {
        const rel = path.relative(this.config.rootPath, filePath);
        if (!rel || rel.startsWith('..')) return false;
        return rel.split(path.sep).some(seg => seg.startsWith('.'));
    }

    _isSupportedMediaFile(filePath) {
        if (this._isSidecarFile(filePath)) return false;
        const ext = path.extname(filePath).toLowerCase();
        return DEFAULT_SUPPORTED_EXTENSIONS.has(ext);
    }

    _getSidecarPath(mediaFilePath) {
        return `${mediaFilePath}${this.config.sidecarSuffix}`;
    }

    async _loadHashMap() {
        this.hashMap.clear();
        try {
            if (!fsSync.existsSync(this.hashMapPath)) {
                await this._saveHashMap();
                return;
            }
            const raw = await fs.readFile(this.hashMapPath, 'utf8');
            const parsed = JSON.parse(raw);
            for (const [hash, info] of Object.entries(parsed || {})) {
                this.hashMap.set(hash, info);
            }
        } catch (error) {
            console.error('[MediaSidecarManager] failed to load hash map:', error.message);
            this.hashMap.clear();
        }
    }

    async _saveHashMap() {
        try {
            const data = {};
            for (const [hash, info] of this.hashMap.entries()) {
                data[hash] = info;
            }
            await fs.writeFile(this.hashMapPath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('[MediaSidecarManager] failed to save hash map:', error.message);
        }
    }

    async _computeFileHash(filePath) {
        const data = await fs.readFile(filePath);
        return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
    }

    async _readPngJpegDescription() {
        return '';
    }

    async _syncPngJpegDescription() {
        return;
    }

    async _buildInitialDescription(mediaFilePath) {
        const ext = path.extname(mediaFilePath).toLowerCase();
        if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            const mediaDescription = await this._readPngJpegDescription(mediaFilePath);
            if (mediaDescription) return mediaDescription;
        }
        return '';
    }

    async _createOrUpdateSidecar(mediaFilePath, options = {}) {
        const { force = false } = options;
        const sidecarPath = this._getSidecarPath(mediaFilePath);

        let mediaStats;
        try {
            mediaStats = await fs.stat(mediaFilePath);
            if (!mediaStats.isFile()) return null;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[MediaSidecarManager] stat media failed:', error.message);
            }
            return null;
        }

        let sidecarExists = false;
        let currentSidecar = null;
        try {
            const raw = await fs.readFile(sidecarPath, 'utf8');
            currentSidecar = JSON.parse(raw);
            sidecarExists = true;
        } catch (error) {
            sidecarExists = false;
        }

        const mediaHash = await this._computeFileHash(mediaFilePath);

        if (!sidecarExists) {
            const recovered = await this._recoverSidecarByHash(mediaHash, sidecarPath);
            if (recovered) {
                currentSidecar = recovered;
                sidecarExists = true;
            }
        }

        if (sidecarExists && !force) {
            return currentSidecar;
        }
        const relativePath = path.relative(this.config.rootPath, mediaFilePath);
        const mimeType = this._guessMimeType(mediaFilePath);
        const now = new Date().toISOString();
        const description = sidecarExists ? (currentSidecar.description || '') : await this._buildInitialDescription(mediaFilePath);
        const tags = Array.isArray(currentSidecar?.tags) ? currentSidecar.tags : [];

        const sidecar = {
            version: 1,
            mediaHash,
            mediaPath: `file://${mediaFilePath}`,
            relativePath,
            mimeType,
            description,
            presetName: currentSidecar?.presetName || 'Cognito-Core',
            tags,
            generator: Array.isArray(currentSidecar?.generator) ? currentSidecar.generator : ['Cognito-Core'],
            source: currentSidecar?.source || 'auto',
            createdAt: currentSidecar?.createdAt || now,
            updatedAt: now
        };

        await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

        this.hashMap.set(mediaHash, {
            relativeMediaPath: relativePath,
            relativeSidecarPath: path.relative(this.config.rootPath, sidecarPath),
            updatedAt: now
        });
        await this._saveHashMap();

        if (this.config.metadataSyncEnabled && (mediaFilePath.toLowerCase().endsWith('.png') || mediaFilePath.toLowerCase().endsWith('.jpg') || mediaFilePath.toLowerCase().endsWith('.jpeg'))) {
            await this._syncPngJpegDescription(mediaFilePath, sidecar.description);
        }

        this.emit('sidecar-upsert', { mediaFilePath, sidecarPath, sidecar });
        this._log(`sidecar upserted: ${path.relative(this.config.rootPath, sidecarPath)}`);
        return sidecar;
    }

    async _removeSidecarForMedia(mediaFilePath) {
        const sidecarPath = this._getSidecarPath(mediaFilePath);
        let sidecar = null;

        try {
            const raw = await fs.readFile(sidecarPath, 'utf8');
            sidecar = JSON.parse(raw);
        } catch (_) { }

        try {
            await fs.unlink(sidecarPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[MediaSidecarManager] remove sidecar failed:', error.message);
            }
        }

        if (sidecar?.mediaHash) {
            this.hashMap.delete(sidecar.mediaHash);
            await this._saveHashMap();
        }

        this.emit('sidecar-delete', { mediaFilePath, sidecarPath, sidecar });
        this._log(`sidecar deleted: ${path.relative(this.config.rootPath, sidecarPath)}`);
    }

    async _removeBySidecarPath(sidecarPath) {
        let sidecar = null;
        try {
            const raw = await fs.readFile(sidecarPath, 'utf8');
            sidecar = JSON.parse(raw);
        } catch (_) { }

        if (sidecar?.mediaHash) {
            this.hashMap.delete(sidecar.mediaHash);
            await this._saveHashMap();
        }

        const mediaFilePath = sidecarPath.slice(0, -this.config.sidecarSuffix.length);
        this.emit('sidecar-delete', { mediaFilePath, sidecarPath, sidecar });
        this._log(`sidecar removed event handled: ${path.relative(this.config.rootPath, sidecarPath)}`);
    }

    _clearPendingDelete(mediaFilePath) {
        const timer = this.pendingDeleteTimers.get(mediaFilePath);
        if (timer) {
            clearTimeout(timer);
            this.pendingDeleteTimers.delete(mediaFilePath);
        }
    }

    _scheduleSidecarCreate(mediaFilePath) {
        if (this.pendingTimers.has(mediaFilePath)) {
            clearTimeout(this.pendingTimers.get(mediaFilePath));
        }

        const timer = setTimeout(async () => {
            this.pendingTimers.delete(mediaFilePath);
            await this._createOrUpdateSidecar(mediaFilePath, { force: false });
        }, this.config.sidecarCreateDelayMs);

        this.pendingTimers.set(mediaFilePath, timer);
    }

    _scheduleSidecarDelete(mediaFilePath) {
        this._clearPendingDelete(mediaFilePath);

        const timer = setTimeout(async () => {
            this.pendingDeleteTimers.delete(mediaFilePath);
            await this._removeSidecarForMedia(mediaFilePath);
        }, this.config.sidecarCreateDelayMs);

        this.pendingDeleteTimers.set(mediaFilePath, timer);
    }

    async _recoverSidecarByHash(mediaHash, targetSidecarPath) {
        const hashInfo = this.hashMap.get(mediaHash);
        if (!hashInfo || !hashInfo.relativeSidecarPath) return null;

        const oldSidecarPath = path.join(this.config.rootPath, hashInfo.relativeSidecarPath);
        if (oldSidecarPath === targetSidecarPath) return null;
        if (!fsSync.existsSync(oldSidecarPath)) return null;

        try {
            await fs.mkdir(path.dirname(targetSidecarPath), { recursive: true });
            await fs.rename(oldSidecarPath, targetSidecarPath);
            const raw = await fs.readFile(targetSidecarPath, 'utf8');
            this._log(`sidecar rename recovered by hash: ${path.relative(this.config.rootPath, oldSidecarPath)} -> ${path.relative(this.config.rootPath, targetSidecarPath)}`);
            return JSON.parse(raw);
        } catch (error) {
            console.error('[MediaSidecarManager] recover sidecar by hash failed:', error.message);
            return null;
        }
    }

    _startWatcher() {
        if (this.watcher) return;

        this.watcher = chokidar.watch(this.config.rootPath, {
            ignored: /(^|[\/\\])\../,
            ignoreInitial: false,
            persistent: true
        });

        this.watcher
            .on('add', async (filePath) => {
                if (this._isDotPath(filePath)) return;

                if (this._isSupportedMediaFile(filePath)) {
                    this._clearPendingDelete(filePath);
                    this._scheduleSidecarCreate(filePath);
                    return;
                }

                if (this._isSidecarFile(filePath)) {
                    this.emit('sidecar-upsert', { mediaFilePath: filePath.slice(0, -this.config.sidecarSuffix.length), sidecarPath: filePath, sidecar: null });
                }
            })
            .on('change', async (filePath) => {
                if (this._isDotPath(filePath)) return;

                if (this._isSupportedMediaFile(filePath)) {
                    this._clearPendingDelete(filePath);
                    await this._createOrUpdateSidecar(filePath, { force: true });
                    return;
                }

                if (this._isSidecarFile(filePath)) {
                    this.emit('sidecar-upsert', { mediaFilePath: filePath.slice(0, -this.config.sidecarSuffix.length), sidecarPath: filePath, sidecar: null });
                }
            })
            .on('unlink', async (filePath) => {
                if (this._isDotPath(filePath)) return;

                if (this._isSupportedMediaFile(filePath)) {
                    this._scheduleSidecarDelete(filePath);
                    return;
                }

                if (this._isSidecarFile(filePath)) {
                    await this._removeBySidecarPath(filePath);
                }
            })
            .on('error', (error) => {
                console.error('[MediaSidecarManager] watcher error:', error.message);
            });
    }

    _guessMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const map = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff',
            '.avif': 'image/avif',
            '.svg': 'image/svg+xml',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.flac': 'audio/flac',
            '.m4a': 'audio/mp4',
            '.aac': 'audio/aac',
            '.ogg': 'audio/ogg',
            '.mp4': 'video/mp4',
            '.mov': 'video/quicktime',
            '.mkv': 'video/x-matroska',
            '.webm': 'video/webm',
            '.avi': 'video/x-msvideo',
            '.pdf': 'application/pdf'
        };
        return map[ext] || 'application/octet-stream';
    }
}

module.exports = new MediaSidecarManager();
