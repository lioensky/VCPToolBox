// VectorDBManager.js
const { Worker } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { HierarchicalNSW } = require('hnswlib-node');
const crypto = require('crypto');
const { chunkText } = require('./TextChunker.js');

// --- Constants ---
const DIARY_ROOT_PATH = path.join(__dirname, 'dailynote'); // Your diary root directory
const VECTOR_STORE_PATH = path.join(__dirname, 'VectorStore'); // Directory to store vector indices
const MANIFEST_PATH = path.join(VECTOR_STORE_PATH, 'manifest.json'); // Path for the manifest file

/**
 * Manages the creation, synchronization, and searching of vector databases for diaries.
 * Implements an incremental update mechanism using a manifest file to avoid re-processing unchanged files on restart.
 */
class VectorDBManager {
    constructor() {
        // API Configuration
        this.apiKey = process.env.API_Key;
        this.apiUrl = process.env.API_URL;
        this.embeddingModel = process.env.WhitelistEmbeddingModel;

        // In-memory cache for performance
        this.indices = new Map(); // { diaryName: hnswIndex }
        this.chunkMaps = new Map(); // { diaryName: {id: chunkData} }
        this.activeWorkers = new Set(); // Tracks diary books currently being processed
        
        // State for incremental updates
        // State for incremental updates. Now stores more details.
        this.manifest = {}; // Back to simple format: { diaryName: { fileName: fileHash } }
    }

    /**
     * Initializes the vector database manager.
     * This is the main entry point to be called from server.js.
     */
    async initialize() {
        console.log('[VectorDB] Initializing Vector Database Manager...');
        await fs.mkdir(VECTOR_STORE_PATH, { recursive: true });
        await this.loadManifest();
        await this.scanAndSyncAll();
        this.watchDiaries();
        console.log('[VectorDB] Initialization complete. Now monitoring diary files for changes.');
    }

    /**
     * Loads the manifest file from disk into memory.
     * If the file doesn't exist, it initializes an empty manifest.
     */
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
                console.error('[VectorDB] Failed to load manifest file, will proceed with a blank one:', error);
                this.manifest = {};
            }
        }
    }

    /**
     * Saves the current in-memory manifest to the disk.
     */
    async saveManifest() {
        try {
            await fs.writeFile(MANIFEST_PATH, JSON.stringify(this.manifest, null, 2));
        } catch (error) {
            console.error('[VectorDB] Critical error: Failed to save manifest file:', error);
        }
    }

    // _getChunkHashes is no longer needed at the class level.

    /**
     * Scans all diary books and synchronizes their vector indices.
     * It intelligently skips books that have not changed since the last run.
     */
    async scanAndSyncAll() {
        const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });
        for (const dirent of diaryBooks) {
            if (dirent.isDirectory()) {
                const diaryName = dirent.name;
                const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
                
                const needsUpdate = await this.checkIfUpdateNeeded(diaryName, diaryPath);
                if (needsUpdate) {
                    console.log(`[VectorDB] Changes detected in "${diaryName}", scheduling background update.`);
                    this.scheduleDiaryBookProcessing(diaryName);
                } else {
                    console.log(`[VectorDB] "${diaryName}" is up-to-date. Pre-loading index into memory.`);
                    // Pre-warm the cache by loading the index if it's not already loaded.
                    this.loadIndexForSearch(diaryName).catch(err => {
                        console.error(`[VectorDB] Failed to pre-load index for ${diaryName}:`, err.message);
                    });
                }
            }
        }
    }

    /**
     * Checks a diary book against the manifest to see if an update is required.
     * @param {string} diaryName - The name of the diary book.
     * @param {string} diaryPath - The full path to the diary book directory.
     * @returns {Promise<boolean>} - True if an update is needed, false otherwise.
     */
    async checkIfUpdateNeeded(diaryName, diaryPath) {
        const diaryManifest = this.manifest[diaryName] || {};
        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

        if (Object.keys(diaryManifest).length !== relevantFiles.length) {
            return true; // File count mismatch
        }

        for (const file of relevantFiles) {
            const oldFileHash = diaryManifest[file];
            if (!oldFileHash) {
                return true; // New file found
            }

            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const currentFileHash = crypto.createHash('md5').update(content).digest('hex');
            
            if (oldFileHash !== currentFileHash) {
                return true; // File content has changed
            }
        }

        return false; // No changes detected
    }
    
    /**
     * Calculates changes for a diary book using a more robust diffing strategy.
     * @param {string} diaryName The name of the diary book.
     * @returns {Promise<object>} A changeset object.
     */
    async calculateChanges(diaryName) {
        const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
        const newFileHashes = {};

        // 1. Load old state from the chunk map
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        let oldChunkMap = {};
        try {
            oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
        } catch (e) { /* Map doesn't exist, treat as empty */ }
        
        const oldChunkHashToLabel = new Map(Object.entries(oldChunkMap).map(([label, data]) => [data.chunkHash, Number(label)]));

        // 2. Build current state from disk
        const currentChunkData = new Map(); // hash -> { text, sourceFile }
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

        // 3. Compare old and new states to build the changeset
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

        return {
            diaryName,
            chunksToAdd,
            labelsToDelete,
            newFileHashes
        };
    }

    /**
     * Fetches embeddings for a batch of text chunks from the API.
     * @param {string[]} chunks - An array of text strings to embed.
     * @returns {Promise<Array<number[]>>} - A promise that resolves to an array of vectors.
     */
    async getEmbeddings(chunks) {
        // This instance method now delegates to the stateless worker function
        return getEmbeddingsInWorker(chunks, {
            apiKey: this.apiKey,
            apiUrl: this.apiUrl,
            embeddingModel: this.embeddingModel,
        });
    }
    
    /**
     * Processes all .txt files in a diary book directory, creates a vector index, and saves it.
     * @param {string} diaryName - The name of the diary book to process.
     * @returns {Promise<object|null>} - An object containing file hashes, or null on failure.
     */
    // This instance method is no longer needed, as its logic is now dispatched to a worker
    // via scheduleDiaryBookProcessing.

    /**
     * Schedules a diary book to be processed in a background worker thread.
     * Prevents multiple workers from running for the same diary simultaneously.
     * @param {string} diaryName The name of the diary book to process.
     */
    async scheduleDiaryBookProcessing(diaryName) {
        if (this.activeWorkers.has(diaryName)) {
            console.log(`[VectorDB] Processing for "${diaryName}" is already in progress. Skipping.`);
            return;
        }

        this.activeWorkers.add(diaryName);
        try {
            // First, get the size of the old index to calculate the change ratio correctly.
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
            let totalOldChunks = 0;
            try {
                const oldChunkMap = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
                totalOldChunks = Object.keys(oldChunkMap).length;
            } catch (e) { /* Map doesn't exist, so count is 0 */ }

            console.log(`[VectorDB] Calculating changes for "${diaryName}"...`);
            const changeset = await this.calculateChanges(diaryName);
            const { chunksToAdd, labelsToDelete } = changeset;
            
            const changeThreshold = 0.5; // 50% change threshold to trigger full rebuild
            const changeRatio = totalOldChunks > 0
                ? (chunksToAdd.length + labelsToDelete.length) / totalOldChunks
                : 1.0; // If there were 0 chunks before, any addition is a 100% change.

            // Decision Logic: When to do a full rebuild vs. incremental update.
            if (totalOldChunks === 0 || changeRatio > changeThreshold) {
                console.log(`[VectorDB] Major changes detected (${(changeRatio * 100).toFixed(1)}%). Scheduling a full rebuild for "${diaryName}".`);
                this.runFullRebuildWorker(diaryName);
            } else if (chunksToAdd.length > 0 || labelsToDelete.length > 0) {
                console.log(`[VectorDB] Minor changes detected. Applying incremental update for "${diaryName}".`);
                await this.applyChangeset(changeset);
                this.activeWorkers.delete(diaryName); // Incremental is faster and blocking, so we can clear here.
            } else {
                console.log(`[VectorDB] No effective changes detected for "${diaryName}". Nothing to do.`);
                this.activeWorkers.delete(diaryName);
            }
        } catch (error) {
            console.error(`[VectorDB] Failed to process diary book "${diaryName}":`, error);
            this.activeWorkers.delete(diaryName);
        }
    }

    /**
     * Runs a full rebuild of a diary book in a background worker.
     * @param {string} diaryName The name of the diary book.
     */
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
                // The worker now returns the simple fileHashes manifest
                this.manifest[message.diaryName] = message.newManifestEntry;
                this.saveManifest();
                console.log(`[VectorDB] Worker successfully completed full rebuild for "${message.diaryName}".`);
            } else {
                console.error(`[VectorDB] Worker failed to process "${message.diaryName}":`, message.error);
            }
        });

        worker.on('error', (error) => {
            console.error(`[VectorDB] Worker for "${diaryName}" encountered an error:`, error);
        });

        worker.on('exit', (code) => {
            this.activeWorkers.delete(diaryName);
            if (code !== 0) {
                console.error(`[VectorDB] Worker for "${diaryName}" stopped with exit code ${code}`);
            }
        });
    }

    /**
     * Sets up a file watcher to automatically update indices when diary files change.
     */
    watchDiaries() {
        const watcher = chokidar.watch(DIARY_ROOT_PATH, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            ignoreInitial: true,
        });

        const handleFileChange = (filePath) => {
            console.log(`[VectorDB] File change detected: ${filePath}`);
            const diaryName = path.basename(path.dirname(filePath));
            this.scheduleDiaryBookProcessing(diaryName);
        };

        watcher
            .on('add', handleFileChange)
            .on('change', handleFileChange)
            .on('unlink', handleFileChange);
    }

    /**
     * Lazily loads a diary's vector index and chunk map from disk into memory.
     * @param {string} diaryName - The name of the diary book to load.
     * @param {number} [dimensions] - The expected dimensions of the vectors. If not provided, it will be inferred.
     * @returns {Promise<boolean>} - True if loading was successful, false otherwise.
     */
    async loadIndexForSearch(diaryName, dimensions) {
        if (this.indices.has(diaryName)) {
            return true; // Already loaded
        }
        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

            await fs.access(indexPath); // Check if index exists before proceeding
            await fs.access(mapPath);

            if (!dimensions) {
                 // Fallback to infer dimensions if not provided (e.g., on initial pre-load)
                 const dummyEmbeddings = await this.getEmbeddings(["."]);
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
            console.log(`[VectorDB] Lazily loaded index for "${diaryName}" into memory.`);
            return true;
        } catch (error) {
             console.error(`[VectorDB] Failed to load index for "${diaryName}":`, error.message);
             return false;
        }
    }

    /**
     * Applies a changeset using auto-increment IDs.
     * @param {object} changeset The changeset from calculateChanges.
     */
    async applyChangeset(changeset) {
        const { diaryName, chunksToAdd, labelsToDelete, newFileHashes } = changeset;

        // 1. Ensure index is loaded
        await this.loadIndexForSearch(diaryName);
        let index = this.indices.get(diaryName);
        let chunkMap = this.chunkMaps.get(diaryName);

        // If index doesn't exist, create it.
        if (!index) {
            if (chunksToAdd.length > 0) {
                const tempVector = await this.getEmbeddings([chunksToAdd[0].text]);
                const dimensions = tempVector[0].length;
                index = new HierarchicalNSW('l2', dimensions);
                index.initIndex(0);
                this.indices.set(diaryName, index);
                chunkMap = {};
                this.chunkMaps.set(diaryName, chunkMap);
            } else {
                 console.log(`[VectorDB] No index and nothing to add for "${diaryName}". Skipping.`);
                 this.manifest[diaryName] = newFileHashes;
                 await this.saveManifest();
                 return;
            }
        }

        // 2. Delete vectors
        if (labelsToDelete.length > 0) {
            // --- Diagnostic Logging ---
            // To make logs less confusing, check if deletions are from files that no longer exist.
            try {
                const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
                const files = await fs.readdir(diaryPath);
                const currentFiles = new Set(files);
                const deletedFilesSources = new Set();
                
                labelsToDelete.forEach(label => {
                    const chunkData = chunkMap[label]; // Check original chunkMap before deletion
                    if (chunkData && !currentFiles.has(chunkData.sourceFile)) {
                        deletedFilesSources.add(chunkData.sourceFile);
                    }
                });

                if (deletedFilesSources.size > 0) {
                    console.log(`[VectorDB] Note: Deleting vectors from file(s) that no longer exist: ${[...deletedFilesSources].join(', ')}`);
                }
            } catch (e) {
                console.warn("[VectorDB] Could not perform diagnostic check for deleted files.", e.message);
            }
            // --- End Diagnostic Logging ---

            console.log(`[VectorDB] Deleting ${labelsToDelete.length} vectors from "${diaryName}".`);
            labelsToDelete.forEach(label => {
                try {
                    index.markDelete(label);
                    delete chunkMap[label];
                } catch (e) { /* Ignore errors for already deleted labels */ }
            });
        }

        // 3. Add new vectors
        if (chunksToAdd.length > 0) {
            console.log(`[VectorDB] Adding ${chunksToAdd.length} new vectors to "${diaryName}".`);
            const texts = chunksToAdd.map(c => c.text);
            const vectors = await this.getEmbeddings(texts);
            
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

        // 4. Save everything
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        
        await index.writeIndex(indexPath);
        await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

        this.manifest[diaryName] = newFileHashes;
        await this.saveManifest();

        console.log(`[VectorDB] Incremental update for "${diaryName}" completed.`);
    }

    /**
     * Searches the vector index for a given diary book.
     * @param {string} diaryName - The name of the diary book to search in.
     * @param {number[]} queryVector - The vector representation of the search query.
     * @param {number} [k=3] - The number of nearest neighbors to return.
     * @returns {Promise<object[]>} - An array of the most relevant chunk objects.
     */
    async search(diaryName, queryVector, k = 3) { 
        console.log(`[VectorDB][Search] Received search request for "${diaryName}".`);
        const isLoaded = await this.loadIndexForSearch(diaryName, queryVector.length);
        if (!isLoaded) {
            console.error(`[VectorDB][Search] Index for "${diaryName}" could not be loaded. Returning empty result.`);
            return [];
        }
        
        const index = this.indices.get(diaryName);
        const chunkMap = this.chunkMaps.get(diaryName);
        if (!index || !chunkMap) {
            console.error(`[VectorDB][Search] Index or chunkMap for "${diaryName}" not found in memory after load. Returning empty result.`);
            return [];
        }
        
        try {
            const efSearch = 150;
            if (typeof index.setEf === 'function') {
                index.setEf(efSearch);
            }
            
            console.log(`[VectorDB][Search] Performing k-NN search in "${diaryName}" with k=${k}.`);
            const result = index.searchKnn(queryVector, k);
            console.log(`[VectorDB][Search] Raw search result labels from HNSW:`, result.neighbors);

            if (!result.neighbors || result.neighbors.length === 0) {
                console.log(`[VectorDB][Search] k-NN search returned no neighbors.`);
                return [];
            }
            
            // With auto-incrementing integer IDs, the label is the key. JSON keys are strings.
            const searchResults = result.neighbors.map(label => chunkMap[label]).filter(Boolean);

            console.log(`[VectorDB][Search] Found ${searchResults.length} matching chunks in chunkMap.`);
            return searchResults;

        } catch (error) {
            console.error(`[VectorDB][Search] An error occurred during k-NN search for "${diaryName}":`, error);
            return [];
        }
    }
}

// --- Standalone functions for Worker ---

/**
 * Fetches embeddings for a batch of text chunks from the API.
 * This is a stateless version for use in workers.
 * @param {string[]} chunks - An array of text strings to embed.
 * @param {object} config - API configuration { apiKey, apiUrl, embeddingModel }.
 * @returns {Promise<Array<number[]>>} - A promise that resolves to an array of vectors.
 */
async function getEmbeddingsInWorker(chunks, config) {
    const { default: fetch } = await import('node-fetch');
    const allVectors = [];
    // Reading from process.env here as a fallback in worker context
    const batchSize = parseInt(process.env.WhitelistEmbeddingModelList) || 5;
    
    console.log(`[VectorDB][Worker] 批量处理配置: batchSize=${batchSize}, 总文本块数=${chunks.length}`);

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
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
            console.log(`[VectorDB][Worker] Successfully processed a batch of ${batch.length} text chunks.`);
        } catch (error) {
            console.error('[VectorDB][Worker] Failed to call Embedding API:', error);
            allVectors.push(...Array(batch.length).fill(null));
        }
    }
    return allVectors.filter(v => v !== null);
}

/**
 * Processes all .txt files in a diary book, creates a vector index, and saves it.
 * This is a stateless version for use in workers.
 * @param {string} diaryName - The name of the diary book to process.
 * @param {object} config - API configuration { apiKey, apiUrl, embeddingModel }.
 * @returns {Promise<object|null>} - An object containing file hashes, or null on failure.
 */
async function processSingleDiaryBookInWorker(diaryName, config) {
    const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
    const files = await fs.readdir(diaryPath);
    const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

    let allChunks = [];
    const fileHashes = {}; // This will be our new, simplified manifest entry
    const chunkMap = {};
    let labelCounter = 0;

    for (const file of relevantFiles) {
        const filePath = path.join(diaryPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        fileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
        
        const chunks = chunkText(content);
        allChunks.push(...chunks);

        chunks.forEach(chunk => {
            const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
            chunkMap[labelCounter] = {
                text: chunk,
                sourceFile: file,
                chunkHash: chunkHash // Keep hash for future diffing
            };
            labelCounter++;
        });
    }

    if (allChunks.length === 0) {
        console.log(`[VectorDB][Worker] Diary book "${diaryName}" is empty. Skipping.`);
        // Return the simple fileHashes manifest. The map will be empty.
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        await fs.writeFile(mapPath, JSON.stringify({}));
        return fileHashes;
    }

    console.log(`[VectorDB][Worker] "${diaryName}" has ${allChunks.length} text chunks for full rebuild. Fetching embeddings...`);
    const vectors = await getEmbeddingsInWorker(allChunks, config);

    if (vectors.length !== allChunks.length) {
        console.error(`[VectorDB][Worker] Embedding failed or vector count mismatch for "${diaryName}". Aborting.`);
        return null;
    }

    const dimensions = vectors[0].length;
    const index = new HierarchicalNSW('l2', dimensions);
    index.initIndex(allChunks.length);
    
    for (let i = 0; i < vectors.length; i++) {
        index.addPoint(vectors[i], i); // The label is now the simple index 'i'
    }

    const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
    const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
    const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

    await index.writeIndex(indexPath);
    // Note: chunkMap keys are numbers, but JSON.stringify will convert them to strings. This is expected.
    await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

    console.log(`[VectorDB][Worker] Index for "${diaryName}" created and saved successfully.`);
    return fileHashes; // Return the simple file hash manifest
}


module.exports = { VectorDBManager, processSingleDiaryBookInWorker };