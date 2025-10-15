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
            .update(Buffer.from(queryVector))
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
        };

        this.apiKey = process.env.API_Key;
        this.apiUrl = process.env.API_URL;
        this.embeddingModel = process.env.WhitelistEmbeddingModel;

        this.indices = new Map();
        this.chunkMaps = new Map();
        this.activeWorkers = new Set();
        this.lruCache = new Map();
        this.manifest = {};
        this.searchCache = new SearchCache(this.config.cacheSize, this.config.cacheTTL);
        this.searchWorkerPool = new WorkerPool(path.resolve(__dirname, 'vectorSearchWorker.js'));

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
        await this.scanAndSyncAll();
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
        try {
            await fs.writeFile(MANIFEST_PATH, JSON.stringify(this.manifest, null, 2));
        } catch (error) {
            console.error('[VectorDB] Critical error: Failed to save manifest file:', error);
        }
    }

    async scanAndSyncAll() {
        const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });
        for (const dirent of diaryBooks) {
            if (dirent.isDirectory()) {
                const diaryName = dirent.name;
                if (diaryName.startsWith('已整理')) {
                    console.log(`[VectorDB] Ignoring folder "${diaryName}" as it is marked as organized.`);
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
        const newFileHashes = {};
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        let oldChunkMap = {};
        try {
            oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
        } catch (e) { /* ignore */ }
        
        const oldChunkHashToLabel = new Map(Object.entries(oldChunkMap).map(([label, data]) => [data.chunkHash, Number(label)]));
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
                    currentChunkData.set(chunkHash, { text: chunk, sourceFile: file });
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
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
            let totalOldChunks = 0;
            try {
                const oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
                totalOldChunks = Object.keys(oldChunkMap).length;
            } catch (e) { /* ignore */ }

            console.log(`[VectorDB] Calculating changes for "${diaryName}"...`);
            const changeset = await this.calculateChanges(diaryName);
            const { chunksToAdd, labelsToDelete } = changeset;
            
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
                config: { apiKey: this.apiKey, apiUrl: this.apiUrl, embeddingModel: this.embeddingModel }
            }
        });

        worker.on('message', (message) => {
            if (message.status === 'success' && message.task === 'fullRebuild') {
                this.manifest[message.diaryName] = message.newManifestEntry;
                this.saveManifest();
                this.stats.lastUpdateTime = new Date().toISOString();
                console.log(`[VectorDB] Worker successfully completed full rebuild for "${message.diaryName}".`);
            } else {
                console.error(`[VectorDB] Worker failed to process "${message.diaryName}":`, message.error);
            }
        });

        worker.on('error', (error) => console.error(`[VectorDB] Worker for "${diaryName}" encountered an error:`, error));
        worker.on('exit', (code) => {
            this.activeWorkers.delete(diaryName);
            if (code !== 0) console.error(`[VectorDB] Worker for "${diaryName}" stopped with exit code ${code}`);
        });
    }

    watchDiaries() {
        const watcher = chokidar.watch(DIARY_ROOT_PATH, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true,
        });

        const handleFileChange = (filePath) => {
            console.log(`[VectorDB] File change detected: ${filePath}`);
            const diaryName = path.basename(path.dirname(filePath));
            if (diaryName.startsWith('已整理')) {
                console.log(`[VectorDB] Ignoring change in "${diaryName}" as it is marked as organized.`);
                return;
            }
            this.scheduleDiaryBookProcessing(diaryName);
        };

        watcher.on('add', handleFileChange).on('change', handleFileChange).on('unlink', handleFileChange);
    }

    async loadIndexForSearch(diaryName, dimensions) {
        if (this.indices.has(diaryName)) {
            // 安全地更新 LRU 缓存
            const cacheEntry = this.lruCache.get(diaryName);
            if (cacheEntry) {
                cacheEntry.lastAccessed = Date.now();
            } else {
                this.lruCache.set(diaryName, { lastAccessed: Date.now() });
            }
            return true;
        }
        await this.manageMemory();

        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

            await fs.access(indexPath);
            await fs.access(mapPath);

            if (!dimensions) {
                 const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
                 if (!dummyEmbeddings || dummyEmbeddings.length === 0) throw new Error("Could not dynamically determine embedding dimensions.");
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
        }
    }

    async applyChangeset(changeset) {
        const { diaryName, chunksToAdd, labelsToDelete, newFileHashes } = changeset;

        await this.loadIndexForSearch(diaryName);
        let index = this.indices.get(diaryName);
        let chunkMap = this.chunkMaps.get(diaryName);

        if (!index) {
            if (chunksToAdd.length > 0) {
                const tempVector = await this.getEmbeddingsWithRetry([chunksToAdd[0].text]);
                const dimensions = tempVector[0].length;
                index = new HierarchicalNSW('l2', dimensions);
                index.initIndex(0);
                this.indices.set(diaryName, index);
                chunkMap = {};
                this.chunkMaps.set(diaryName, chunkMap);
            } else {
                 this.manifest[diaryName] = newFileHashes;
                 await this.saveManifest();
                 return;
            }
        }

        if (labelsToDelete.length > 0) {
            console.log(`[VectorDB] Deleting ${labelsToDelete.length} vectors from "${diaryName}".`);
            labelsToDelete.forEach(label => {
                try {
                    index.markDelete(label);
                    delete chunkMap[label];
                } catch (e) { /* ignore */ }
            });
        }

        if (chunksToAdd.length > 0) {
            console.log(`[VectorDB] Adding ${chunksToAdd.length} new vectors to "${diaryName}".`);
            const texts = chunksToAdd.map(c => c.text);
            const vectors = await this.getEmbeddingsWithRetry(texts);
            
            let maxLabel = Object.keys(chunkMap).reduce((max, label) => Math.max(max, Number(label)), -1);
            
            index.resizeIndex(index.getMaxElements() + vectors.length);

            for (let i = 0; i < vectors.length; i++) {
                const newLabel = ++maxLabel;
                const chunk = chunksToAdd[i];
                index.addPoint(vectors[i], newLabel);
                chunkMap[newLabel] = {
                    text: chunk.text,
                    sourceFile: chunk.sourceFile,
                    chunkHash: chunk.chunkHash
                };
            }
        }

        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        
        await index.writeIndex(indexPath);
        await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

        this.manifest[diaryName] = newFileHashes;
        await this.saveManifest();
        this.stats.lastUpdateTime = new Date().toISOString();
        console.log(`[VectorDB] Incremental update for "${diaryName}" completed.`);
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

        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        try {
            await fs.access(indexPath);
        } catch (error) {
            console.error(`[VectorDB][Search] Index file for "${diaryName}" does not exist. Cannot start search worker.`);
            return [];
        }

        try {
            console.log(`[VectorDB][Search] Queuing search task for "${diaryName}" in worker pool.`);
            const workerData = {
                diaryName,
                queryVector,
                k,
                efSearch: this.config.efSearch,
                vectorStorePath: VECTOR_STORE_PATH,
            };
            
            const message = await this.searchWorkerPool.execute(workerData);
            
            console.log(`[VectorDB][Search] Received message from worker for "${diaryName}". Status: ${message.status}`);
            if (message.status === 'success') {
                const searchResults = message.results;
                this.searchCache.set(diaryName, queryVector, k, searchResults);
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
                this.indices.delete(diaryName);
                this.chunkMaps.delete(diaryName);
                this.lruCache.delete(diaryName);
                console.log(`[VectorDB] Evicted index for "${diaryName}" from memory.`);
            }
        }
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
            await fs.writeFile(USAGE_STATS_PATH, JSON.stringify(stats, null, 2));
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
}

// --- Standalone functions for Worker ---
async function getEmbeddingsInWorker(chunks, config) {
    const { default: fetch } = await import('node-fetch');
    const allVectors = [];
    const batchSize = parseInt(process.env.VECTORDB_BATCH_SIZE) || 5;

    // --- Retry Config from environment variables ---
    const retryAttempts = parseInt(process.env.VECTORDB_RETRY_ATTEMPTS) || 3;
    const retryBaseDelay = parseInt(process.env.VECTORDB_RETRY_BASE_DELAY_MS) || 1000;
    const retryMaxDelay = parseInt(process.env.VECTORDB_RETRY_MAX_DELAY_MS) || 10000;

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
                    throw new Error(`Embedding API error: ${response.status} ${response.statusText} - ${errorBody}`);
                }

                const data = await response.json();
                const vectors = data.data.map(item => item.embedding);
                allVectors.push(...vectors);
                
                lastError = null; // Success, clear last error
                break; // Exit retry loop and proceed to next batch
            } catch (error) {
                lastError = error;
                console.error(`[VectorDB][Worker] Batch (start: ${i}) attempt ${attempt} failed:`, error.message);
                if (attempt < retryAttempts) {
                    const delay = Math.min(retryBaseDelay * Math.pow(2, attempt - 1), retryMaxDelay);
                    console.log(`[VectorDB][Worker] Retrying batch in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        // If a batch fails after all retries, the whole operation must fail.
        if (lastError) {
            console.error(`[VectorDB][Worker] Failed to process batch (start: ${i}) after ${retryAttempts} attempts.`);
            throw new Error(`Failed to get embeddings for a batch after ${retryAttempts} attempts: ${lastError.message}`);
        }
    }
    return allVectors;
}

async function processSingleDiaryBookInWorker(diaryName, config) {
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
            allChunks.push(chunk);
            chunkMap[labelCounter] = {
                text: chunk,
                sourceFile: file,
                chunkHash: chunkHash
            };
            labelCounter++;
        }
    }

    const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
    const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

    if (allChunks.length === 0) {
        console.log(`[VectorDB][Worker] Diary book "${diaryName}" is empty. Skipping.`);
        await fs.writeFile(mapPath, JSON.stringify({}));
        // Also clear the binary index file if it exists
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        try { await fs.unlink(indexPath); } catch(e) { /* ignore if not found */ }
        return fileHashes;
    }

    console.log(`[VectorDB][Worker] "${diaryName}" has ${allChunks.length} text chunks. Fetching embeddings...`);
    const vectors = await getEmbeddingsInWorker(allChunks, config);

    if (vectors.length !== allChunks.length) {
        throw new Error(`Embedding failed or vector count mismatch for "${diaryName}".`);
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