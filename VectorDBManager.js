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
        this.manifest = {}; // { diaryName: { fileName: { fileHash, chunkHashes: [] } } }
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

    /**
     * Calculates the SHA256 hash for each text chunk.
     * @param {string[]} chunks - An array of text chunks.
     * @returns {string[]} - An array of SHA256 hashes.
     */
    _getChunkHashes(chunks) {
        return chunks.map(chunk => crypto.createHash('sha256').update(chunk).digest('hex'));
    }

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

        // Quick check for file count mismatch
        if (Object.keys(diaryManifest).length !== relevantFiles.length) {
            return true;
        }

        for (const file of relevantFiles) {
            const fileManifest = diaryManifest[file];
            if (!fileManifest) {
                return true; // New file found
            }
            
            // In new format, manifest stores an object, not just a hash
            const oldFileHash = typeof fileManifest === 'string' ? fileManifest : fileManifest.fileHash;
            if (!oldFileHash) {
                 return true; // Malformed manifest entry, needs rebuild
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
     * Calculates the detailed changes (added/deleted chunks) for a diary book.
     * @param {string} diaryName - The name of the diary book.
     * @returns {Promise<object>} - A changeset object detailing files and chunks to add or delete.
     */
    async calculateChanges(diaryName) {
        const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
        const oldDiaryManifest = this.manifest[diaryName] || {};
        const newDiaryManifest = {};
        
        const changeset = {
            diaryName: diaryName,
            chunksToAdd: [],    // { text, chunkHash, sourceFile }
            labelsToDelete: [], // [label_integer]
            newManifest: {}     // The final manifest state for this diary book
        };

        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));
        
        const oldFiles = new Set(Object.keys(oldDiaryManifest));
        
        for (const file of relevantFiles) {
            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const newFileHash = crypto.createHash('md5').update(content).digest('hex');
            
            const oldFileManifest = oldDiaryManifest[file];
            const oldFileHash = oldFileManifest ? oldFileManifest.fileHash : null;

            if (newFileHash === oldFileHash) {
                // File is unchanged, carry over the old manifest.
                newDiaryManifest[file] = oldFileManifest;
            } else {
                // File is new or modified.
                const newChunks = chunkText(content);
                const newChunkHashes = this._getChunkHashes(newChunks);
                newDiaryManifest[file] = { fileHash: newFileHash, chunkHashes: newChunkHashes };

                const oldChunkHashes = new Set(oldFileManifest ? oldFileManifest.chunkHashes : []);
                const newChunkHashesSet = new Set(newChunkHashes);

                // Find chunks to delete from this file
                if (oldFileManifest) {
                    for (const oldHash of oldFileManifest.chunkHashes) {
                        if (!newChunkHashesSet.has(oldHash)) {
                            changeset.labelsToDelete.push(parseInt(oldHash.substring(0, 15), 16));
                        }
                    }
                }

                // Find chunks to add from this file
                for (let i = 0; i < newChunks.length; i++) {
                    const newHash = newChunkHashes[i];
                    if (!oldChunkHashes.has(newHash)) {
                        changeset.chunksToAdd.push({
                            text: newChunks[i],
                            chunkHash: newHash,
                            sourceFile: file
                        });
                    }
                }
            }
            oldFiles.delete(file); // Mark this file as processed.
        }

        // Any files left in oldFiles have been deleted from disk.
        for (const deletedFile of oldFiles) {
            const deletedFileManifest = oldDiaryManifest[deletedFile];
            if (deletedFileManifest && deletedFileManifest.chunkHashes) {
                for (const oldHash of deletedFileManifest.chunkHashes) {
                    changeset.labelsToDelete.push(parseInt(oldHash.substring(0, 15), 16));
                }
            }
        }
        
        changeset.newManifest = newDiaryManifest;
        return changeset;
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
            console.log(`[VectorDB] Calculating changes for "${diaryName}"...`);
            const changeset = await this.calculateChanges(diaryName);
            const { chunksToAdd, labelsToDelete } = changeset;

            const totalChunksInManifest = Object.values(this.manifest[diaryName] || {})
                .reduce((acc, file) => acc + (file.chunkHashes ? file.chunkHashes.length : 0), 0);

            const changeThreshold = 0.5; // 50% change threshold to trigger full rebuild
            const changeRatio = totalChunksInManifest > 0
                ? (chunksToAdd.length + labelsToDelete.length) / totalChunksInManifest
                : 1.0;

            // Decision Logic: When to do a full rebuild vs. incremental update.
            if (!this.manifest[diaryName] || changeRatio > changeThreshold) {
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
     * Applies a changeset to the in-memory and on-disk index.
     * @param {object} changeset - The changeset from calculateChanges.
     */
    async applyChangeset(changeset) {
        const { diaryName, chunksToAdd, labelsToDelete, newManifest } = changeset;

        // Ensure index is loaded before modification.
        // We need to determine dimensions to create an index if it's new.
        let dimensions = this.indices.has(diaryName) ? this.indices.get(diaryName).getNumDimensions() : null;
        if (!dimensions && chunksToAdd.length > 0) {
            // Infer dimensions from the first chunk to be added.
            const tempVector = await this.getEmbeddings([chunksToAdd[0].text]);
            if (tempVector && tempVector.length > 0) {
                dimensions = tempVector[0].length;
            }
        }

        if (!this.indices.has(diaryName)) {
            if (dimensions) {
                console.log(`[VectorDB] Creating new in-memory index for ${diaryName} with ${dimensions} dimensions.`);
                const index = new HierarchicalNSW('l2', dimensions);
                index.initIndex(0); // init empty
                this.indices.set(diaryName, index);
                this.chunkMaps.set(diaryName, {});
            } else {
                 console.log(`[VectorDB] No changes and no dimensions for ${diaryName}. Nothing to do.`);
                 // If there's nothing to add or delete, and no index exists, we just ensure manifest is up-to-date.
                 this.manifest[diaryName] = newManifest;
                 await this.saveManifest();
                 return;
            }
        }

        const index = this.indices.get(diaryName);
        const chunkMap = this.chunkMaps.get(diaryName);

        // 1. Delete vectors
        if (labelsToDelete.length > 0) {
            console.log(`[VectorDB] Deleting ${labelsToDelete.length} vectors from "${diaryName}" index.`);
            for (const label of labelsToDelete) {
                try {
                    // markDelete might throw if label doesn't exist, which is fine.
                    index.markDelete(label);
                    delete chunkMap[label];
                } catch (e) {
                    console.warn(`[VectorDB] Label ${label} not found for deletion in ${diaryName}. Might have been already deleted.`);
                }
            }
        }

        // 2. Add new vectors
        if (chunksToAdd.length > 0) {
            const texts = chunksToAdd.map(c => c.text);
            const vectors = await this.getEmbeddings(texts);
            
            console.log(`[VectorDB] Adding ${vectors.length} new vectors to "${diaryName}" index.`);
            if (index.getMaxElements() < index.getCurrentCount() + vectors.length) {
                 index.resizeIndex(index.getCurrentCount() + vectors.length);
            }
            
            for (let i = 0; i < vectors.length; i++) {
                const vector = vectors[i];
                const chunk = chunksToAdd[i];
                const label = parseInt(chunk.chunkHash.substring(0, 15), 16);
                index.addPoint(vector, label);
                chunkMap[label] = { text: chunk.text, sourceFile: chunk.sourceFile };
            }
        }
        
        // 3. Save the updated index and map to disk
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);
        
        await index.writeIndex(indexPath);
        await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

        // 4. Update and save the manifest
        this.manifest[diaryName] = newManifest;
        await this.saveManifest();

        console.log(`[VectorDB] Incremental update for "${diaryName}" completed successfully.`);
    }

    /**
     * Searches the vector index for a given diary book.
     * @param {string} diaryName - The name of the diary book to search in.
     * @param {number[]} queryVector - The vector representation of the search query.
     * @param {number} [k=3] - The number of nearest neighbors to return.
     * @returns {Promise<object[]>} - An array of the most relevant chunk objects.
     */
    async search(diaryName, queryVector, k = 3) {
        const isLoaded = await this.loadIndexForSearch(diaryName, queryVector.length);
        if (!isLoaded) {
            return [];
        }
        
        const index = this.indices.get(diaryName);
        const chunkMap = this.chunkMaps.get(diaryName);
        if (!index || !chunkMap) return [];
        
        try {
            // 新增：在搜索前设置本次查询的搜索范围
            const efSearch = 150; // (推荐范围 50-200, 必须 > k)
            
            // 修正：使用正确的方法名 setEf
            if (typeof index.setEf === 'function') {
                index.setEf(efSearch);
            }
            
            const result = index.searchKnn(queryVector, k);
            
            // The labels are now chunkHash-derived integers
            return result.neighbors.map(label => chunkMap[label]).filter(Boolean);
        } catch (error) {
            console.error(`[VectorDB] Search error for ${diaryName}:`, error);
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
    let chunkMetadata = [];
    const newManifestEntry = {};

    for (const file of relevantFiles) {
        const filePath = path.join(diaryPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const fileHash = crypto.createHash('md5').update(content).digest('hex');
        const chunks = chunkText(content);
        const chunkHashes = chunks.map(chunk => crypto.createHash('sha256').update(chunk).digest('hex'));
        
        newManifestEntry[file] = { fileHash, chunkHashes };

        allChunks.push(...chunks);
        chunks.forEach((chunk, index) => {
            const chunkHash = chunkHashes[index];
            // The ID for HNSW will be the chunkHash itself
            chunkMetadata.push({
                sourceFile: file,
                text: chunk,
                chunkHash: chunkHash
            });
        });
    }

    if (allChunks.length === 0) {
        console.log(`[VectorDB][Worker] Diary book "${diaryName}" is empty. Skipping.`);
        return newManifestEntry;
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
    
    const chunkMap = {};
    
    // We now use chunkHash as the unique label in the index
    for (let i = 0; i < vectors.length; i++) {
        const vector = vectors[i];
        const meta = chunkMetadata[i];
        const label = parseInt(meta.chunkHash.substring(0, 15), 16); // HNSW requires an integer label
        index.addPoint(vector, label);
        chunkMap[label] = { text: meta.text, sourceFile: meta.sourceFile };
    }

    const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
    const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
    const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

    await index.writeIndex(indexPath);
    await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

    console.log(`[VectorDB][Worker] Index for "${diaryName}" created and saved successfully.`);
    // Return the new manifest structure for the main thread to save.
    return newManifestEntry;
}


module.exports = { VectorDBManager, processSingleDiaryBookInWorker };