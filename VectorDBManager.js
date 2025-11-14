// VectorDBManager.js
const { Worker } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { HierarchicalNSW } = require('hnswlib-node');
const crypto = require('crypto');
const { chunkText } = require('./TextChunker.js');
const WorkerPool = require('./WorkerPool.js');

// --- Constants ---
const DIARY_ROOT_PATH = path.join(__dirname, 'dailynote'); // Your diary root directory
const VECTOR_STORE_PATH = path.join(__dirname, 'VectorStore'); // Directory to store vector indices
const MANIFEST_PATH = path.join(VECTOR_STORE_PATH, 'manifest.json'); // Path for the manifest file
const USAGE_STATS_PATH = path.join(VECTOR_STORE_PATH, 'usage_stats.json'); // Usage statistics
const DIARY_NAME_VECTOR_CACHE_PATH = path.join(VECTOR_STORE_PATH, 'diary_name_vectors.json'); // Path for the diary name vector cache

/**
 * LRU Cache with TTL for search results
 */
class SearchCache {
    constructor(maxSize = 100, ttl = 60000) { // 1-minute TTL
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.hits = 0;
        this.misses = 0;
    }

    getCacheKey(diaryName, queryVector, k) {
        const vectorHash = crypto.createHash('md5')
            .update(JSON.stringify(queryVector))
            .digest('hex');
        return `${diaryName}-${vectorHash}-${k}`;
    }

    get(diaryName, queryVector, k) {
        const key = this.getCacheKey(diaryName, queryVector, k);
        const entry = this.cache.get(key);
        
        if (entry && Date.now() - entry.timestamp < this.ttl) {
            this.hits++;
            return entry.result;
        }
        
        this.cache.delete(key);
        this.misses++;
        return null;
    }

    set(diaryName, queryVector, k, result) {
        const key = this.getCacheKey(diaryName, queryVector, k);
        
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(key, {
            result,
            timestamp: Date.now()
        });
    }

    getStats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? (this.hits / total * 100).toFixed(2) + '%' : '0%',
            size: this.cache.size,
            maxSize: this.maxSize
        };
    }
}

/**
 * Manages the creation, synchronization, and searching of vector databases for diaries.
 */
class VectorDBManager {
    constructor(config = {}) {
        this.config = {
            changeThreshold: parseFloat(process.env.VECTORDB_CHANGE_THRESHOLD) || 0.5,
            maxMemoryUsage: (parseInt(process.env.VECTORDB_MAX_MEMORY_MB) || 500) * 1024 * 1024,
            cacheSize: parseInt(process.env.VECTORDB_CACHE_SIZE) || 100,
            cacheTTL: parseInt(process.env.VECTORDB_CACHE_TTL_MS) || 60000,
            retryAttempts: parseInt(process.env.VECTORDB_RETRY_ATTEMPTS) || 3,
            retryBaseDelay: parseInt(process.env.VECTORDB_RETRY_BASE_DELAY_MS) || 1000,
            retryMaxDelay: parseInt(process.env.VECTORDB_RETRY_MAX_DELAY_MS) || 10000,
            preWarmCount: parseInt(process.env.VECTORDB_PREWARM_COUNT) || 5,
            efSearch: parseInt(process.env.VECTORDB_EF_SEARCH) || 150,
            debug: process.env.VECTORDB_DEBUG === 'true',
        };

        this.apiKey = process.env.API_Key;
        this.apiUrl = process.env.API_URL;
        this.embeddingModel = process.env.WhitelistEmbeddingModel;

        this.indices = new Map();
        this.chunkMaps = new Map();
        this.activeWorkers = new Set();
        this.lruCache = new Map();
        this.manifest = {};
        this.diaryNameVectors = new Map(); // 新增：缓存日记本名称的向量
        this.searchCache = new SearchCache(this.config.cacheSize, this.config.cacheTTL);
        this.searchWorkerPool = new WorkerPool(path.resolve(__dirname, 'vectorSearchWorker.js'));
        this.failedRebuilds = new Map();
        this.fileLocks = new Map(); // ✅ 新增文件锁

        this.stats = {
            totalIndices: 0,
            totalChunks: 0,
            totalSearches: 0,
            avgSearchTime: 0,
            lastUpdateTime: null,
        };

        console.log('[VectorDB] Initialized with config:', {
            changeThreshold: this.config.changeThreshold,
            maxMemoryMB: this.config.maxMemoryUsage / 1024 / 1024,
            cacheSize: this.config.cacheSize,
            cacheTTL: this.config.cacheTTL,
            retryAttempts: this.config.retryAttempts,
        });
    }

    debugLog(message, ...args) {
        if (this.config.debug) {
            console.log(`[VectorDB][DEBUG] ${message}`, ...args);
        }
    }

    /**
     * 获取文件锁（带超时）
     * @param {string} diaryName - 日记本名称
     */
    async acquireLock(diaryName) {
        const lockKey = `lock_${diaryName}`;
        let attempts = 0;
        const maxAttempts = 100; // 5秒超时（100 * 50ms）
        
        while (this.fileLocks.get(lockKey)) {
            if (attempts++ >= maxAttempts) {
                const lock = this.fileLocks.get(lockKey);
                const heldDuration = Date.now() - (lock?.acquiredAt || 0);
                throw new Error(
                    `[VectorDB] Failed to acquire lock for "${diaryName}" after ${maxAttempts * 50}ms.\n` +
                    `Lock acquired at: ${new Date(lock?.acquiredAt).toISOString()}\n` +
                    `Held for: ${heldDuration}ms`
                );
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        this.fileLocks.set(lockKey, {
            acquiredAt: Date.now(),
            stack: new Error().stack // ✅ 调试用：记录调用栈
        });
        
        this.debugLog(`Lock acquired for "${diaryName}"`);
    }

    /**
     * 释放文件锁
     * @param {string} diaryName - 日记本名称
     */
    releaseLock(diaryName) {
        const lockKey = `lock_${diaryName}`;
        const lock = this.fileLocks.get(lockKey);
        
        if (lock) {
            const heldDuration = Date.now() - lock.acquiredAt;
            this.fileLocks.delete(lockKey);
            this.debugLog(`Lock released for "${diaryName}" (held for ${heldDuration}ms)`);
        } else {
            console.warn(`[VectorDB] Attempted to release non-existent lock for "${diaryName}"`);
        }
    }

    /**
     * 记录性能指标
     */
    recordMetric(type, duration) {
        if (type === 'search_success') {
            this.stats.totalSearches++;
            this.stats.avgSearchTime =
                (this.stats.avgSearchTime * (this.stats.totalSearches - 1) + duration)
                / this.stats.totalSearches;
        }
    }

    getHealthStatus() {
        const totalChunks = Array.from(this.chunkMaps.values()).reduce((sum, map) => sum + Object.keys(map).length, 0);
        return {
            status: 'healthy',
            stats: {
                ...this.stats,
                totalIndices: this.indices.size,
                totalChunks: totalChunks,
                workerQueueLength: this.activeWorkers.size,
                memoryUsage: process.memoryUsage().heapUsed,
            },
            activeWorkers: Array.from(this.activeWorkers),
            loadedIndices: Array.from(this.indices.keys()),
            manifestVersion: Object.keys(this.manifest).length,
            cacheStats: this.searchCache.getStats(),
        };
    }

    async initialize() {
        console.log('[VectorDB] Initializing Vector Database Manager...');
        await fs.mkdir(VECTOR_STORE_PATH, { recursive: true });
        await this.loadManifest();
        await this.loadFailedRebuilds();
        await this.scanAndSyncAll();
        await this.cacheDiaryNameVectors(); // 新增：缓存日记本名称向量
        await this.preWarmIndices();
        this.watchDiaries();
        console.log('[VectorDB] Initialization complete. Now monitoring diary files for changes.');
    }

    async loadManifest() {
        try {
            const data = await fs.readFile(MANIFEST_PATH, 'utf-8');
            this.manifest = JSON.parse(data);
            console.log('[VectorDB] Successfully loaded the vector manifest file.');
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('[VectorDB] Manifest file not found. A new one will be created.');
                this.manifest = {};
            } else {
                console.error('[VectorDB] Failed to load manifest file:', error);
                this.manifest = {};
            }
        }
    }

    async saveManifest() {
        const tempManifestPath = `${MANIFEST_PATH}.tmp`;
        try {
            await fs.writeFile(tempManifestPath, JSON.stringify(this.manifest, null, 2));
            await fs.rename(tempManifestPath, MANIFEST_PATH); // ✅ 原子操作
            this.debugLog('Manifest saved successfully');
        } catch (error) {
            console.error('[VectorDB] Critical error: Failed to save manifest file:', error);
            // 清理临时文件
            try {
                if (await this.fileExists(tempManifestPath)) {
                    await fs.unlink(tempManifestPath);
                }
            } catch (e) { /* ignore */ }
        }
    }

    async scanAndSyncAll() {
        const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });
        for (const dirent of diaryBooks) {
            if (dirent.isDirectory()) {
                const diaryName = dirent.name;
                if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                    console.log(`[VectorDB] Ignoring folder "${diaryName}" as it is in the exclusion list.`);
                    continue;
                }
                const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
                
                const needsUpdate = await this.checkIfUpdateNeeded(diaryName, diaryPath);
                if (needsUpdate) {
                    console.log(`[VectorDB] Changes detected in "${diaryName}", scheduling background update.`);
                    this.scheduleDiaryBookProcessing(diaryName);
                } else {
                    console.log(`[VectorDB] "${diaryName}" is up-to-date. Index will be loaded on demand.`);
                }
            }
        }
    }

    async checkIfUpdateNeeded(diaryName, diaryPath) {
        // ✅ 检查是否在暂停期
        if (this.failedRebuilds && this.failedRebuilds.has(diaryName)) {
            const record = this.failedRebuilds.get(diaryName);
            if (record.pauseUntil && Date.now() < record.pauseUntil) {
                this.debugLog(`[VectorDB] Update check for "${diaryName}" is paused until ${new Date(record.pauseUntil).toISOString()}`);
                return false;
            }
        }

        const diaryManifest = this.manifest[diaryName] || {};
        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

        if (Object.keys(diaryManifest).length !== relevantFiles.length) return true;

        for (const file of relevantFiles) {
            const oldFileHash = diaryManifest[file];
            if (!oldFileHash) return true;

            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const currentFileHash = crypto.createHash('md5').update(content).digest('hex');
            
            if (oldFileHash !== currentFileHash) return true;
        }
        return false;
    }

    async calculateChanges(diaryName) {
        const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
        
        // ✅ 再次检查（防御性编程）
        try {
            await fs.access(diaryPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`[VectorDB][calculateChanges] Directory "${diaryName}" does not exist.`);
                return { diaryName, chunksToAdd: [], labelsToDelete: [], newFileHashes: {} };
            }
            throw error;
        }
        
        const newFileHashes = {};
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        let oldChunkMap = {};
        try {
            oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));

            // ✅ 修复：验证数据完整性
            const validEntries = Object.entries(oldChunkMap).filter(([label, data]) => {
                if (!data || typeof data.chunkHash === 'undefined') { // Check for both null data and missing chunkHash
                    console.warn(`[VectorDB] Invalid entry in chunkMap for "${diaryName}", label ${label}: missing chunkHash or data is null.`);
                    return false;
                }
                return true;
            });

            if (validEntries.length < Object.keys(oldChunkMap).length) {
                console.warn(`[VectorDB] Found ${Object.keys(oldChunkMap).length - validEntries.length} invalid entries in "${diaryName}". Triggering full rebuild.`);
                // 标记需要全量重建
                return {
                    diaryName,
                    chunksToAdd: [],
                    labelsToDelete: [],
                    newFileHashes: {},
                    forceFullRebuild: true  // ✅ 新增标志
                };
            }
            
            oldChunkMap = Object.fromEntries(validEntries);
        } catch (e) {
            this.debugLog(`Failed to load old chunk map for "${diaryName}", it might be new or corrupted:`, e.message);
            oldChunkMap = {};
        }
        
        const oldChunkHashToLabel = new Map(Object.entries(oldChunkMap).map(([label, data]) => [data.chunkHash, Number(label)]));

        // ✅ 修复：防御性检查, 防止 undefined key 导致 size 异常
        if (oldChunkHashToLabel.has(undefined)) {
            oldChunkHashToLabel.delete(undefined);
        }
        if (Object.keys(oldChunkMap).length > 0 && oldChunkHashToLabel.size < Object.keys(oldChunkMap).length * 0.9) {
            console.error(`[VectorDB] Severe data corruption detected in "${diaryName}": ${oldChunkHashToLabel.size} unique hashes vs ${Object.keys(oldChunkMap).length} entries. Forcing full rebuild.`);
            return {
                diaryName,
                chunksToAdd: [],
                labelsToDelete: [],
                newFileHashes: {},
                forceFullRebuild: true
            };
        }
        const currentChunkData = new Map();
        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

        for (const file of relevantFiles) {
            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            newFileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
            const chunks = chunkText(content);
            for (const chunk of chunks) {
                const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
                if (!currentChunkData.has(chunkHash)) {
                    currentChunkData.set(chunkHash, {
                        text: chunk,  // ✅ 存储原文
                        sourceFile: file,
                    });
                }
            }
        }

        const currentChunkHashes = new Set(currentChunkData.keys());
        const chunksToAdd = [];
        for (const currentHash of currentChunkHashes) {
            if (!oldChunkHashToLabel.has(currentHash)) {
                const data = currentChunkData.get(currentHash);
                chunksToAdd.push({ ...data, chunkHash: currentHash });
            }
        }

        const labelsToDelete = [];
        for (const [oldHash, oldLabel] of oldChunkHashToLabel.entries()) {
            if (!currentChunkHashes.has(oldHash)) {
                labelsToDelete.push(oldLabel);
            }
        }

        return { diaryName, chunksToAdd, labelsToDelete, newFileHashes };
    }

    async getEmbeddings(chunks) {
        return getEmbeddingsInWorker(chunks, {
            apiKey: this.apiKey,
            apiUrl: this.apiUrl,
            embeddingModel: this.embeddingModel,
        });
    }

    async getEmbeddingsWithRetry(chunks) {
        let lastError;
        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                return await this.getEmbeddings(chunks);
            } catch (error) {
                lastError = error;
                console.log(`[VectorDB] Embedding attempt ${attempt} failed:`, error.message);
                if (attempt < this.config.retryAttempts) {
                    const delay = Math.min(this.config.retryBaseDelay * Math.pow(2, attempt - 1), this.config.retryMaxDelay);
                    console.log(`[VectorDB] Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw new Error(`Failed to get embeddings after ${this.config.retryAttempts} attempts: ${lastError.message}`);
    }

    async scheduleDiaryBookProcessing(diaryName) {
        if (this.activeWorkers.has(diaryName)) {
            console.log(`[VectorDB] Processing for "${diaryName}" is already in progress. Skipping.`);
            return;
        }

        this.activeWorkers.add(diaryName);
        try {
            const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
            
            // ✅ 检查目录是否存在
            try {
                await fs.access(diaryPath);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(`[VectorDB] Directory "${diaryName}" no longer exists. Cleaning up resources...`);
                    await this.cleanupDeletedDiary(diaryName);
                    this.activeWorkers.delete(diaryName);
                    return;
                }
                throw error; // 其他错误继续抛出
            }

            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
            let totalOldChunks = 0;
            try {
                const oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
                totalOldChunks = Object.keys(oldChunkMap).length;
            } catch (e) { /* ignore */ }

            console.log(`[VectorDB] Calculating changes for "${diaryName}"...`);
            const changeset = await this.calculateChanges(diaryName);
            const { chunksToAdd, labelsToDelete, forceFullRebuild } = changeset;

            if (forceFullRebuild) {
                console.log(`[VectorDB] Full rebuild forced for "${diaryName}" due to data integrity issues.`);
                this.runFullRebuildWorker(diaryName);
                return; // Stop further processing
            }
            
            const changeRatio = totalOldChunks > 0 ? (chunksToAdd.length + labelsToDelete.length) / totalOldChunks : 1.0;
 
            if (totalOldChunks === 0 || changeRatio > this.config.changeThreshold) {
                console.log(`[VectorDB] Major changes detected (${(changeRatio * 100).toFixed(1)}%). Scheduling a full rebuild for "${diaryName}".`);
                this.runFullRebuildWorker(diaryName);
            } else if (chunksToAdd.length > 0 || labelsToDelete.length > 0) {
                console.log(`[VectorDB] Minor changes detected. Applying incremental update for "${diaryName}".`);
                await this.applyChangeset(changeset);
                this.activeWorkers.delete(diaryName);
            } else {
                console.log(`[VectorDB] No effective changes detected for "${diaryName}". Nothing to do.`);
                this.activeWorkers.delete(diaryName);
            }
        } catch (error) {
            console.error(`[VectorDB] Failed to process diary book "${diaryName}":`, error);
            this.activeWorkers.delete(diaryName);
        }
    }

    runFullRebuildWorker(diaryName) {
        const worker = new Worker(path.resolve(__dirname, 'vectorizationWorker.js'), {
            workerData: {
                task: 'fullRebuild',
                diaryName,
                config: {
                    apiKey: this.apiKey,
                    apiUrl: this.apiUrl,
                    embeddingModel: this.embeddingModel,
                    // ✅ 传递配置
                    retryAttempts: this.config.retryAttempts,
                    retryBaseDelay: this.config.retryBaseDelay,
                    retryMaxDelay: this.config.retryMaxDelay,
                }
            }
        });

        worker.on('message', (message) => {
            if (message.status === 'success' && message.task === 'fullRebuild') {
                this.manifest[message.diaryName] = message.newManifestEntry;
                this.saveManifest();
                this.stats.lastUpdateTime = new Date().toISOString();
                console.log(`[VectorDB] Worker successfully completed full rebuild for "${message.diaryName}".`);
            } else if (message.status === 'error') {
                console.error(`[VectorDB] Worker failed for "${message.diaryName}":`, message.error);
                // ✅ 修复：记录失败，防止无限重试
                this.recordFailedRebuild(message.diaryName, message.error);
            } else {
                console.error(`[VectorDB] Worker failed to process "${message.diaryName}" with an unknown message status:`, message);
                this.recordFailedRebuild(diaryName, 'Unknown worker failure');
            }
        });

        worker.on('error', (error) => {
            console.error(`[VectorDB] Worker error for "${diaryName}":`, error);
            this.recordFailedRebuild(diaryName, error.message);
        });
        
        worker.on('exit', (code) => {
            this.activeWorkers.delete(diaryName);
            if (code !== 0) {
                console.error(`[VectorDB] Worker exited with code ${code} for "${diaryName}"`);
                this.recordFailedRebuild(diaryName, `Worker exit code ${code}`);
            }
        });
    }

    /**
     * ✅ 新增方法：清理已删除日记本的所有资源
     */
    async cleanupDeletedDiary(diaryName) {
        await this.acquireLock(diaryName); // ✅ 加锁
        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

            // 1. 从内存中删除索引和块映射
            this.indices.delete(diaryName);
            this.chunkMaps.delete(diaryName);
            this.lruCache.delete(diaryName);
            console.log(`[VectorDB] Removed "${diaryName}" from in-memory indices.`);

            // 2. 删除向量存储文件
            const deletePromises = [];
            
            if (await this.fileExists(indexPath)) {
                deletePromises.push(
                    fs.unlink(indexPath)
                        .then(() => console.log(`[VectorDB] Deleted index file for "${diaryName}".`))
                        .catch(e => console.warn(`[VectorDB] Failed to delete index file:`, e.message))
                );
            }

            if (await this.fileExists(mapPath)) {
                deletePromises.push(
                    fs.unlink(mapPath)
                        .then(() => console.log(`[VectorDB] Deleted map file for "${diaryName}".`))
                        .catch(e => console.warn(`[VectorDB] Failed to delete map file:`, e.message))
                );
            }

            await Promise.all(deletePromises);

            // 3. 从 manifest 中删除
            if (this.manifest[diaryName]) {
                delete this.manifest[diaryName];
                await this.saveManifest();
                console.log(`[VectorDB] Removed "${diaryName}" from manifest.`);
            }

            // 4. 清理使用统计
            let usageStats = await this.loadUsageStats();
            if (usageStats[diaryName]) {
                delete usageStats[diaryName];
                await this.atomicWriteFile(USAGE_STATS_PATH, JSON.stringify(usageStats, null, 2));
                console.log(`[VectorDB] Removed "${diaryName}" from usage statistics.`);
            }

            console.log(`[VectorDB] Successfully cleaned up all resources for deleted diary "${diaryName}".`);
        } catch (error) {
            console.error(`[VectorDB] Error during cleanup of "${diaryName}":`, error);
        } finally {
            this.releaseLock(diaryName); // ✅ 释放锁
        }
    }

    watchDiaries() {
        const watcher = chokidar.watch(DIARY_ROOT_PATH, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true,
            // ✅ 启用目录监听
            depth: 1,
        });

        const handleFileChange = (filePath) => {
            const diaryName = path.basename(path.dirname(filePath));
            if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                return;
            }
            console.log(`[VectorDB] File change detected: ${filePath}`);
            this.scheduleDiaryBookProcessing(diaryName);
            // 触发日记本名称向量的重新缓存
            this.cacheDiaryNameVectors();
        };

        // ✅ 处理目录删除
        const handleDirUnlink = (dirPath) => {
            const diaryName = path.basename(dirPath);
            if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                return;
            }
            console.log(`[VectorDB] Directory deleted: ${diaryName}`);
            // 直接清理，不需要通过 scheduleDiaryBookProcessing
            this.cleanupDeletedDiary(diaryName).catch(err => {
                console.error(`[VectorDB] Error cleaning up deleted directory "${diaryName}":`, err);
            });
            // 触发日记本名称向量的重新缓存
            this.cacheDiaryNameVectors();
        };

        watcher
            .on('add', handleFileChange)
            .on('change', handleFileChange)
            .on('unlink', handleFileChange)
            .on('unlinkDir', handleDirUnlink); // ✅ 监听目录删除
    }

    /**
     * 智能清理文本中的无意义emoji和特殊字符
     * 保留有语义价值的符号
     */
    prepareTextForEmbedding(text) {
        // 1. 移除纯装饰性emoji
        const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
        
        // 2. 保留有语义的标点和符号（！？。，等）
        let cleaned = text.replace(decorativeEmojis, ' ');
        
        // 3. 清理多余空格
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
        
        // 4. 如果清理后为空，返回占位符
        if (cleaned.length === 0) {
            return '[EMPTY_CONTENT]';
        }
        
        return cleaned;
    }

    /**
     * ✅ 通用原子写入方法
     */
    async atomicWriteFile(filePath, data) {
        const tempPath = `${filePath}.tmp`;
        try {
            await fs.writeFile(tempPath, data);
            await fs.rename(tempPath, filePath);
            this.debugLog(`Atomically wrote to ${path.basename(filePath)}`);
        } catch (error) {
            console.error(`[VectorDB] Failed to write ${filePath}:`, error);
            try {
                if (await this.fileExists(tempPath)) {
                    await fs.unlink(tempPath);
                }
            } catch (e) { /* ignore */ }
            throw error;
        }
    }

    async loadIndexForSearch(diaryName, dimensions) {
        if (this.indices.has(diaryName)) {
            // ✅ 直接 set，Map 的 set 操作是原子的
            this.lruCache.set(diaryName, { lastAccessed: Date.now() });
            return true;
        }

        await this.acquireLock(diaryName);
        try {
            // 双重检查（double-check locking）
            if (this.indices.has(diaryName)) {
                return true;
            }

            await this.manageMemory();

            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

            await fs.access(indexPath);
            await fs.access(mapPath);

            if (!dimensions) {
                const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
                if (!dummyEmbeddings || dummyEmbeddings.length === 0) {
                    throw new Error("Could not dynamically determine embedding dimensions.");
                }
                dimensions = dummyEmbeddings[0].length;
            }

            const index = new HierarchicalNSW('l2', dimensions);
            index.readIndexSync(indexPath);
            
            const mapData = await fs.readFile(mapPath, 'utf-8');
            
            this.indices.set(diaryName, index);
            this.chunkMaps.set(diaryName, JSON.parse(mapData));
            this.lruCache.set(diaryName, { lastAccessed: Date.now() });
            console.log(`[VectorDB] Lazily loaded index for "${diaryName}" into memory.`);
            return true;
        } catch (error) {
            console.error(`[VectorDB] Failed to load index for "${diaryName}":`, error.message);
            return false;
        } finally {
            this.releaseLock(diaryName);
        }
    }

    async applyChangeset(changeset) {
        const { diaryName, chunksToAdd, labelsToDelete, newFileHashes } = changeset;

        await this.acquireLock(diaryName); // ✅ 加锁
        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
            
            const backupIndexPath = `${indexPath}.backup`;
            const backupMapPath = `${mapPath}.backup`;

            // 第一阶段：创建备份
            try {
                if (await this.fileExists(indexPath)) await fs.copyFile(indexPath, backupIndexPath);
                if (await this.fileExists(mapPath)) await fs.copyFile(mapPath, backupMapPath);
            } catch (e) {
                this.debugLog(`Backup failed (probably first creation):`, e.message);
            }
            
            // ✅ 直接访问索引，避免死锁（我们已经持有锁）
            let index = this.indices.get(diaryName);
            let chunkMap = this.chunkMaps.get(diaryName);
            
            // 如果索引未加载，手动加载（不加锁，因为我们已经持有锁）
            if (!index) {
                const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
                const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
                const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
                
                try {
                    await fs.access(indexPath);
                    await fs.access(mapPath);
                    
                    // 需要先知道dimensions才能加载索引
                    // 我们稍后会在需要时获取
                    const mapData = await fs.readFile(mapPath, 'utf-8');
                    chunkMap = JSON.parse(mapData);
                    this.chunkMaps.set(diaryName, chunkMap);
                    
                    // 暂时不加载索引，等到确定需要时再加载
                    this.debugLog(`Found existing map for "${diaryName}", will load index if needed.`);
                } catch (e) {
                    this.debugLog(`No existing index found for "${diaryName}", will create new one if needed.`);
                }
            }

            const originalChunkMap = JSON.parse(JSON.stringify(chunkMap || {}));

            // ✅ 预处理：先过滤再决定操作
            let validChunksToAdd = [];
            let validTextsForEmbedding = [];
            
            if (chunksToAdd.length > 0) {
                const textsForEmbedding = chunksToAdd.map(c => this.prepareTextForEmbedding(c.text));
                validChunksToAdd = chunksToAdd.filter((_, i) => textsForEmbedding[i] !== '[EMPTY_CONTENT]');
                validTextsForEmbedding = validChunksToAdd.map(c => this.prepareTextForEmbedding(c.text));
                
                if (validChunksToAdd.length < chunksToAdd.length) {
                    console.warn(`[VectorDB] Filtered out ${chunksToAdd.length - validChunksToAdd.length} empty/emoji-only chunks for "${diaryName}"`);
                }
            }

            // 如果既没有有效新增，也没有删除，直接返回
            if (validChunksToAdd.length === 0 && labelsToDelete.length === 0) {
                console.log(`[VectorDB] No valid changes for "${diaryName}". Updating manifest only.`);
                this.manifest[diaryName] = newFileHashes;
                await this.saveManifest();
                return;
            }

            // 初始化索引（如果需要）
            if (!index) {
                const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
                const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
                
                // 尝试加载现有索引
                try {
                    await fs.access(indexPath);
                    
                    // 获取dimensions
                    let dimensions;
                    if (validTextsForEmbedding.length > 0) {
                        const tempVector = await this.getEmbeddingsWithRetry([validTextsForEmbedding[0]]);
                        dimensions = tempVector[0].length;
                    } else {
                        const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
                        dimensions = dummyEmbeddings[0].length;
                    }
                    
                    index = new HierarchicalNSW('l2', dimensions);
                    index.readIndexSync(indexPath);
                    this.indices.set(diaryName, index);
                    this.lruCache.set(diaryName, { lastAccessed: Date.now() });
                    console.log(`[VectorDB] Loaded existing index for "${diaryName}" in applyChangeset.`);
                } catch (e) {
                    // 索引文件不存在，创建新索引
                    if (validTextsForEmbedding.length > 0) {
                        const tempVector = await this.getEmbeddingsWithRetry([validTextsForEmbedding[0]]);
                        const dimensions = tempVector[0].length;
                        index = new HierarchicalNSW('l2', dimensions);
                        index.initIndex(validChunksToAdd.length);
                        this.indices.set(diaryName, index);
                        chunkMap = {};
                        this.chunkMaps.set(diaryName, chunkMap);
                        console.log(`[VectorDB] Created new index for "${diaryName}".`);
                    } else {
                        // 只有删除操作，但索引不存在，无法操作
                        console.warn(`[VectorDB] Cannot perform delete-only operation without existing index for "${diaryName}"`);
                        this.manifest[diaryName] = newFileHashes;
                        await this.saveManifest();
                        return;
                    }
                }
            }

            // 第二阶段：删除操作
            if (labelsToDelete.length > 0) {
                console.log(`[VectorDB] Deleting ${labelsToDelete.length} vectors from "${diaryName}".`);
                labelsToDelete.forEach(label => {
                    try {
                        index.markDelete(label);
                        delete chunkMap[label];
                    } catch (e) {
                        console.warn(`[VectorDB] Failed to delete label ${label}:`, e.message);
                    }
                });
            }

            // 第三阶段：获取embeddings
            let vectors = [];
            if (validTextsForEmbedding.length > 0) {
                try {
                    vectors = await this.getEmbeddingsWithRetry(validTextsForEmbedding);
                    
                    if (vectors.length !== validTextsForEmbedding.length) {
                        throw new Error(`Embedding count mismatch: expected ${validTextsForEmbedding.length}, got ${vectors.length}`);
                    }
                } catch (error) {
                    console.error(`[VectorDB] Embedding failed, rolling back changes for "${diaryName}":`, error.message);
                    
                    this.chunkMaps.set(diaryName, originalChunkMap);
                    
                    if (await this.fileExists(backupIndexPath)) {
                        await fs.copyFile(backupIndexPath, indexPath);
                        this.indices.delete(diaryName);
                    }
                    
                    throw error;
                }
            }

            // 第四阶段：添加新向量
            if (vectors.length > 0) {
                console.log(`[VectorDB] Adding ${vectors.length} new vectors to "${diaryName}".`);
                let maxLabel = Object.keys(chunkMap).reduce((max, label) => Math.max(max, Number(label)), -1);
                
                // ✅ 修复：手动计算当前数量
                const currentCount = Object.keys(chunkMap).length;
                const requiredCapacity = currentCount + vectors.length;
                const currentCapacity = index.getMaxElements();

                if (requiredCapacity > currentCapacity) {
                    const newCapacity = Math.ceil(Math.max(requiredCapacity, currentCapacity * 1.2));
                    console.log(`[VectorDB] Resizing index from ${currentCapacity} to ${newCapacity}`);
                    index.resizeIndex(newCapacity);
                }

                for (let i = 0; i < vectors.length; i++) {
                    const newLabel = ++maxLabel;
                    const chunk = validChunksToAdd[i];
                    try {
                        index.addPoint(vectors[i], newLabel);
                        chunkMap[newLabel] = {
                            text: chunk.text,
                            sourceFile: chunk.sourceFile,
                            chunkHash: chunk.chunkHash
                        };
                    } catch (e) {
                        console.error(`[VectorDB] Failed to add point ${newLabel}:`, e.message);
                    }
                }
            }

            // 第五阶段：原子性保存
            const tempIndexPath = `${indexPath}.tmp`;
            const tempMapPath = `${mapPath}.tmp`;
            
            // ✅ 确保写入完成并验证文件存在
            try {
                await index.writeIndex(tempIndexPath);
                
                // 验证索引文件是否成功创建
                if (!await this.fileExists(tempIndexPath)) {
                    throw new Error(`Index file was not created at ${tempIndexPath}`);
                }
                
                await fs.writeFile(tempMapPath, JSON.stringify(chunkMap, null, 2));
                
                // 验证map文件是否成功创建
                if (!await this.fileExists(tempMapPath)) {
                    throw new Error(`Map file was not created at ${tempMapPath}`);
                }
                
                // 原子性重命名
                await fs.rename(tempIndexPath, indexPath);
                await fs.rename(tempMapPath, mapPath);
            } catch (writeError) {
                // 清理可能存在的临时文件
                try {
                    if (await this.fileExists(tempIndexPath)) await fs.unlink(tempIndexPath);
                    if (await this.fileExists(tempMapPath)) await fs.unlink(tempMapPath);
                } catch (cleanupError) {
                    console.warn(`[VectorDB] Failed to cleanup temp files:`, cleanupError.message);
                }
                throw writeError;
            }

            // 第六阶段：更新manifest
            this.manifest[diaryName] = newFileHashes;
            await this.saveManifest(); // ✅ 已改为原子操作

            // 成功后删除备份
            try {
                if (await this.fileExists(backupIndexPath)) await fs.unlink(backupIndexPath);
                if (await this.fileExists(backupMapPath)) await fs.unlink(backupMapPath);
            } catch (e) { /* ignore */ }

            this.stats.lastUpdateTime = new Date().toISOString();
            console.log(`[VectorDB] Incremental update for "${diaryName}" completed successfully.`);
            
        } catch (error) {
            console.error(`[VectorDB] Critical error during changeset application for "${diaryName}":`, error);
            
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
            const backupIndexPath = `${indexPath}.backup`;
            const backupMapPath = `${mapPath}.backup`;
            
            try {
                if (await this.fileExists(backupIndexPath)) {
                    await fs.copyFile(backupIndexPath, indexPath);
                    await fs.copyFile(backupMapPath, mapPath);
                    console.log(`[VectorDB] Restored from backup for "${diaryName}"`);
                }
            } catch (restoreError) {
                console.error(`[VectorDB] Failed to restore from backup:`, restoreError);
            }
            
            console.log(`[VectorDB] Scheduling full rebuild for "${diaryName}" after failed incremental update.`);
            this.runFullRebuildWorker(diaryName);
        } finally {
            this.releaseLock(diaryName); // ✅ 释放锁
        }
    }

    async search(diaryName, queryVector, k = 3) {
        const startTime = performance.now();
        const cached = this.searchCache.get(diaryName, queryVector, k);
        if (cached) {
            console.log(`[VectorDB][Search] Cache hit for "${diaryName}"`);
            this.recordMetric('search_success', performance.now() - startTime);
            return cached;
        }

        console.log(`[VectorDB][Search] Received async search request for "${diaryName}".`);
        await this.trackUsage(diaryName);

        // --- Bug Fix: K-value Sanity Check ---
        // 1. Ensure the index is loaded to check its size.
        const loaded = await this.loadIndexForSearch(diaryName);
        if (!loaded) {
            console.error(`[VectorDB][Search] Index for "${diaryName}" could not be loaded. Aborting search.`);
            return [];
        }

        const index = this.indices.get(diaryName);
        const maxElements = index.getMaxElements();

        // 2. If the index is empty, no search is possible.
        if (maxElements === 0) {
            console.log(`[VectorDB][Search] Index for "${diaryName}" is empty. Returning no results.`);
            return [];
        }

        // 3. Clamp the k-value to be no larger than the number of elements in the index.
        const finalK = Math.min(k, maxElements);
        if (finalK !== k) {
            console.warn(`[VectorDB][Search] Requested k=${k} is greater than max elements (${maxElements}) for "${diaryName}". Clamping to k=${finalK}.`);
        }
        // --- End of Bug Fix ---

        try {
            console.log(`[VectorDB][Search] Queuing search task for "${diaryName}" in worker pool.`);
            const workerData = {
                diaryName,
                queryVector,
                k: finalK, // Use the sanitized k-value
                efSearch: this.config.efSearch,
                vectorStorePath: VECTOR_STORE_PATH,
            };
            
            const message = await this.searchWorkerPool.execute(workerData);
            
            console.log(`[VectorDB][Search] Received message from worker for "${diaryName}". Status: ${message.status}`);
            if (message.status === 'success') {
                const searchResults = message.results;
                this.searchCache.set(diaryName, queryVector, k, searchResults); // Cache with original k
                this.recordMetric('search_success', performance.now() - startTime);
                console.log(`[VectorDB][Search] Worker found ${searchResults.length} matching chunks for "${diaryName}".`);
                return searchResults;
            } else {
                console.error(`[VectorDB][Search] Worker returned an error for "${diaryName}":`, message.error);
                return [];
            }
        } catch (error) {
            console.error(`[VectorDB][Search] Worker pool task for "${diaryName}" encountered a critical error:`, error);
            return [];
        }
    }

    /**
     * 根据文本内容获取对应的向量
     * @param {string} diaryName - 日记本名称
     * @param {string} text - 要查找的文本
     * @returns {Array|null} - 返回对应的向量，如果未找到则返回null
     */
    async getVectorByText(diaryName, text) {
        try {
            // 确保索引已加载
            const loaded = await this.loadIndexForSearch(diaryName);
            if (!loaded) {
                console.error(`[VectorDB][getVectorByText] Failed to load index for "${diaryName}"`);
                return null;
            }

            const index = this.indices.get(diaryName);
            const chunkMap = this.chunkMaps.get(diaryName);

            if (!index || !chunkMap) {
                console.error(`[VectorDB][getVectorByText] Index or chunkMap not found for "${diaryName}"`);
                return null;
            }

            // 在 chunkMap 中查找匹配的文本
            const trimmedText = text.trim();
            for (const [label, data] of Object.entries(chunkMap)) {
                if (data.text.trim() === trimmedText) {
                    // 找到匹配的文本，从索引中获取向量
                    try {
                        const vector = index.getPoint(Number(label));
                        return vector;
                    } catch (error) {
                        console.error(`[VectorDB][getVectorByText] Error getting vector for label ${label}:`, error.message);
                        return null;
                    }
                }
            }

            console.warn(`[VectorDB][getVectorByText] Text not found in chunkMap for "${diaryName}"`);
            return null;
        } catch (error) {
            console.error(`[VectorDB][getVectorByText] Error:`, error);
            return null;
        }
    }

    async manageMemory() {
        const memUsage = process.memoryUsage().heapUsed;
        if (memUsage > this.config.maxMemoryUsage) {
            console.log('[VectorDB] Memory threshold exceeded, evicting least recently used indices...');
            const entries = Array.from(this.lruCache.entries()).sort(([,a], [,b]) => a.lastAccessed - b.lastAccessed);
            for (const [diaryName] of entries) {
                if (process.memoryUsage().heapUsed < this.config.maxMemoryUsage * 0.8) break;
                
                // ✅ 跳过正在处理的索引
                if (this.activeWorkers.has(diaryName)) {
                    console.log(`[VectorDB] Skipping "${diaryName}" - currently active`);
                    continue;
                }
                
                this.indices.delete(diaryName);
                this.chunkMaps.delete(diaryName);
                this.lruCache.delete(diaryName);
                console.log(`[VectorDB] Evicted index for "${diaryName}" from memory.`);
            }
        }
    }

    /**
     * 从文件加载日记本名称向量缓存
     */
    async loadDiaryNameVectors() {
        try {
            const data = await fs.readFile(DIARY_NAME_VECTOR_CACHE_PATH, 'utf-8');
            const entries = JSON.parse(data);
            this.diaryNameVectors = new Map(entries);
            console.log(`[VectorDB] Loaded ${this.diaryNameVectors.size} diary name vectors from cache.`);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('[VectorDB] Diary name vector cache not found. Will create a new one.');
                this.diaryNameVectors = new Map();
            } else {
                console.error('[VectorDB] Failed to load diary name vector cache:', error);
                this.diaryNameVectors = new Map();
            }
        }
    }

    /**
     * 保存日记本名称向量缓存到文件
     */
    async saveDiaryNameVectors() {
        try {
            const data = JSON.stringify(Array.from(this.diaryNameVectors.entries()));
            await this.atomicWriteFile(DIARY_NAME_VECTOR_CACHE_PATH, data);
        } catch (error) {
            console.error('[VectorDB] Failed to save diary name vector cache:', error);
        }
    }

    /**
     * 同步并缓存所有日记本名称的向量（增量更新）
     */
    async cacheDiaryNameVectors() {
        console.log('[VectorDB] Starting to sync diary book name vectors...');
        await this.loadDiaryNameVectors(); // 首先加载现有缓存

        const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });
        const currentDiaryNames = new Set();
        for (const dirent of diaryBooks) {
            if (dirent.isDirectory() && !dirent.name.startsWith('已整理') && dirent.name !== 'VCP论坛') {
                currentDiaryNames.add(dirent.name);
            }
        }

        const cachedNames = new Set(this.diaryNameVectors.keys());
        let hasChanges = false;

        // 检查已删除的日记本
        for (const cachedName of cachedNames) {
            if (!currentDiaryNames.has(cachedName)) {
                this.diaryNameVectors.delete(cachedName);
                hasChanges = true;
                console.log(`[VectorDB] Removed deleted diary "${cachedName}" from name vector cache.`);
            }
        }

        // 检查新增的日记本
        const namesToVectorize = [];
        for (const currentName of currentDiaryNames) {
            if (!cachedNames.has(currentName)) {
                namesToVectorize.push(currentName);
            }
        }

        if (namesToVectorize.length > 0) {
            console.log(`[VectorDB] Found ${namesToVectorize.length} new diary books to vectorize.`);
            hasChanges = true;
            try {
                const vectors = await this.getEmbeddingsWithRetry(namesToVectorize);
                if (vectors.length !== namesToVectorize.length) {
                    throw new Error(`Vectorization count mismatch: expected ${namesToVectorize.length}, got ${vectors.length}`);
                }
                for (let i = 0; i < namesToVectorize.length; i++) {
                    this.diaryNameVectors.set(namesToVectorize[i], vectors[i]);
                }
            } catch (error) {
                console.error('[VectorDB] Failed to vectorize new diary book names:', error);
                // 如果向量化失败，则不保存，避免写入部分状态
                return;
            }
        }

        if (hasChanges) {
            await this.saveDiaryNameVectors();
            console.log(`[VectorDB] Diary name vector cache updated. Total entries: ${this.diaryNameVectors.size}.`);
        } else {
            console.log('[VectorDB] Diary name vector cache is up-to-date.');
        }
    }

    /**
     * 获取缓存的日记本名称向量
     * @param {string} diaryName - 日记本名称
     * @returns {Array|null} - 向量数组或null
     */
    getDiaryNameVector(diaryName) {
        return this.diaryNameVectors.get(diaryName) || null;
    }

    async loadUsageStats() {
        try {
            const data = await fs.readFile(USAGE_STATS_PATH, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return {};
        }
    }

    async trackUsage(diaryName) {
        let stats = await this.loadUsageStats();
        if (!stats[diaryName]) {
            stats[diaryName] = { frequency: 0, lastAccessed: null };
        }
        stats[diaryName].frequency++;
        stats[diaryName].lastAccessed = Date.now();
        try {
            await this.atomicWriteFile(USAGE_STATS_PATH, JSON.stringify(stats, null, 2));
        } catch (e) {
            console.warn('[VectorDB] Failed to save usage stats:', e.message);
        }
    }

    async preWarmIndices() {
        console.log('[VectorDB] Starting index pre-warming...');
        const usageStats = await this.loadUsageStats();
        const sortedDiaries = Object.entries(usageStats)
            .sort(([,a], [,b]) => b.frequency - a.frequency)
            .map(([name]) => name);
        
        const preLoadCount = Math.min(this.config.preWarmCount, sortedDiaries.length);
        if (preLoadCount === 0) {
            console.log('[VectorDB] No usage stats found, skipping pre-warming.');
            return;
        }
        const preLoadPromises = sortedDiaries
            .slice(0, preLoadCount)
            .map(diaryName => this.loadIndexForSearch(diaryName));
        
        await Promise.all(preLoadPromises);
        console.log(`[VectorDB] Pre-warmed ${preLoadCount} most frequently used indices.`);
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    recordFailedRebuild(diaryName, errorMessage) {
        if (!this.failedRebuilds) {
            this.failedRebuilds = new Map();
        }
        
        const now = Date.now();
        const record = this.failedRebuilds.get(diaryName) || {
            count: 0,
            firstAttempt: now,  // ✅ 记录第一次失败时间
            lastAttempt: 0,
            lastError: ''
        };
        
        record.count++;
        record.lastAttempt = now;
        record.lastError = errorMessage;
        
        // ✅ 修复：检查从第一次失败到现在的时间间隔
        const timeSpan = now - record.firstAttempt;
        
        // 如果1小时内失败3次，暂停24小时
        if (record.count >= 3 && timeSpan < 3600000) {
            console.error(
                `[VectorDB] "${diaryName}" has failed ${record.count} times within ${(timeSpan / 60000).toFixed(1)} minutes. ` +
                `Pausing for 24 hours.`
            );
            record.pauseUntil = now + 24 * 3600000;
        }
        
        // ✅ 如果超过1小时后又失败了，重置计数
        if (timeSpan > 3600000) {
            record.count = 1;
            record.firstAttempt = now;
            delete record.pauseUntil;
        }
        
        this.failedRebuilds.set(diaryName, record);
        
        // 持久化失败记录
        this.saveFailedRebuilds();
    }

    async saveFailedRebuilds() {
        const failedRebuildPath = path.join(VECTOR_STORE_PATH, 'failed_rebuilds.json');
        try {
            const data = JSON.stringify(Array.from(this.failedRebuilds.entries()), null, 2);
            await this.atomicWriteFile(failedRebuildPath, data);
        } catch (error) {
            console.error('[VectorDB] Failed to save failed rebuild records:', error);
        }
    }

    async loadFailedRebuilds() {
        const failedRebuildPath = path.join(VECTOR_STORE_PATH, 'failed_rebuilds.json');
        try {
            const data = await fs.readFile(failedRebuildPath, 'utf-8');
            this.failedRebuilds = new Map(JSON.parse(data));
            console.log(`[VectorDB] Loaded ${this.failedRebuilds.size} failed rebuild records.`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[VectorDB] Failed to load failed rebuild records:', error);
            }
            this.failedRebuilds = new Map();
        }
    }

    async shutdown() {
        console.log('[VectorDB] Shutting down worker pool...');
        if (this.searchWorkerPool && typeof this.searchWorkerPool.terminate === 'function') {
            await this.searchWorkerPool.terminate();
            console.log('[VectorDB] Worker pool shut down successfully.');
        } else {
            console.log('[VectorDB] Worker pool not found or does not have a terminate method.');
        }
    }
}

// --- Standalone functions for Worker ---
async function getEmbeddingsInWorker(chunks, config) {
    const { default: fetch } = await import('node-fetch');
    const allVectors = [];
    const batchSize = parseInt(process.env.VECTORDB_BATCH_SIZE) || 5;

    const retryAttempts = config.retryAttempts || 3;
    const retryBaseDelay = config.retryBaseDelay || 1000;
    const retryMaxDelay = config.retryMaxDelay || 10000;

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        let lastError;
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                const response = await fetch(`${config.apiUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`
                    },
                    body: JSON.stringify({
                        model: config.embeddingModel,
                        input: batch
                    })
                });

                if (!response.ok) {
                    const errorBody = await response.text();
                    const err = new Error(`Embedding API error: ${response.status} - ${errorBody}`);
                    err.status = response.status;
                    err.headers = response.headers; // ✅ 保存headers
                    throw err;
                }

                const data = await response.json();
                
                if (!data.data || !Array.isArray(data.data)) {
                    throw new Error(`Invalid API response: missing data array`);
                }
                
                const vectors = data.data.map(item => item.embedding);
                
                for (let j = 0; j < vectors.length; j++) {
                    if (!vectors[j] || !Array.isArray(vectors[j]) || vectors[j].length === 0) {
                        throw new Error(`Invalid embedding at index ${j} for text: "${batch[j].substring(0, 50)}..."`);
                    }
                }
                
                if (vectors.length !== batch.length) {
                    throw new Error(`Batch size mismatch: sent ${batch.length}, received ${vectors.length}`);
                }
                
                allVectors.push(...vectors);
                
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                console.error(`[VectorDB][Worker] Batch attempt ${attempt}/${retryAttempts} failed:`, error.message);
                
                if (attempt < retryAttempts) {
                    let delay;
                    
                    if (error.status === 429) {
                        const retryAfter = error.headers?.get('retry-after');
                        if (retryAfter) {
                            if (/^\d+$/.test(retryAfter)) {
                                delay = parseInt(retryAfter) * 1000;
                            } else {
                                const retryDate = new Date(retryAfter);
                                delay = retryDate.getTime() - Date.now();
                            }
                            delay = Math.max(0, Math.min(delay, 60000)); // Wait at most 60s
                        } else {
                            delay = 30000; // Default 30s
                        }
                        console.log(`[VectorDB][Worker] Rate limited (429). Waiting ${delay}ms...`);
                    } else {
                        delay = Math.min(retryBaseDelay * Math.pow(2, attempt - 1), retryMaxDelay);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        if (lastError) {
            throw new Error(
                `Failed to embed batch (chunks ${i}-${i+batch.length-1}) after ${retryAttempts} attempts.\n` +
                `Last error: ${lastError.message}\n` +
                `Sample text: "${batch[0].substring(0, 100)}..."`
            );
        }
    }
    return allVectors;
}

async function processSingleDiaryBookInWorker(diaryName, config) {
    // ✅ 定义 emoji 清理函数（与主类保持一致）
    const prepareTextForEmbedding = (text) => {
        const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
        let cleaned = text.replace(decorativeEmojis, ' ').replace(/\s+/g, ' ').trim();
        return cleaned.length === 0 ? '[EMPTY_CONTENT]' : cleaned;
    };

    const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
    const files = await fs.readdir(diaryPath);
    const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

    let allChunks = [];
    const fileHashes = {};
    const chunkMap = {};
    let labelCounter = 0;

    for (const file of relevantFiles) {
        const filePath = path.join(diaryPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        fileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
        
        const chunks = chunkText(content);
        for (const chunk of chunks) {
            const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
            
            // ✅ 检查清理后是否有效
            const cleanedText = prepareTextForEmbedding(chunk);
            if (cleanedText === '[EMPTY_CONTENT]') {
                console.warn(`[VectorDB][Worker] Skipping empty/emoji-only chunk from "${file}"`);
                continue; // ✅ 跳过无效chunk
            }
            
            allChunks.push(chunk); // ✅ 存储原文
            chunkMap[labelCounter] = {
                text: chunk,  // ✅ 保存原文
                sourceFile: file,
                chunkHash: chunkHash
            };
            labelCounter++;
        }
    }

    const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
    const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

    if (allChunks.length === 0) {
        console.log(`[VectorDB][Worker] Diary book "${diaryName}" is empty (all chunks filtered). Skipping.`);
        await fs.writeFile(mapPath, JSON.stringify({}));
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        try { await fs.unlink(indexPath); } catch(e) { /* ignore if not found */ }
        return fileHashes;
    }

    console.log(`[VectorDB][Worker] "${diaryName}" has ${allChunks.length} valid text chunks. Preparing for embedding...`);
    
    // ✅ 使用清理后的文本进行embedding
    const textsForEmbedding = allChunks.map(chunk => prepareTextForEmbedding(chunk));
    const vectors = await getEmbeddingsInWorker(textsForEmbedding, config);

    if (vectors.length !== allChunks.length) {
        throw new Error(`Embedding failed or vector count mismatch for "${diaryName}". Expected ${allChunks.length}, got ${vectors.length}`);
    }

    const dimensions = vectors[0].length;
    const index = new HierarchicalNSW('l2', dimensions);
    index.initIndex(allChunks.length);
    
    for (let i = 0; i < vectors.length; i++) {
        index.addPoint(vectors[i], i);
    }

    const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
    await index.writeIndex(indexPath);
    await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

    console.log(`[VectorDB][Worker] Index for "${diaryName}" created and saved successfully.`);
    return fileHashes;
}

module.exports = { VectorDBManager, processSingleDiaryBookInWorker };