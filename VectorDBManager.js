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
        this.manifest = {}; // { diaryName: { fileName: hash } }
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
        const manifestHashes = this.manifest[diaryName] || {};
        const files = await fs.readdir(diaryPath);
        const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));

        if (Object.keys(manifestHashes).length !== txtFiles.length) {
            return true; // File count mismatch
        }

        for (const file of txtFiles) {
            if (!manifestHashes[file]) {
                return true; // New file found
            }
            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const currentHash = crypto.createHash('md5').update(content).digest('hex');
            if (manifestHashes[file] !== currentHash) {
                return true; // File content has changed
            }
        }
        return false; // No changes detected
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
    scheduleDiaryBookProcessing(diaryName) {
        if (this.activeWorkers.has(diaryName)) {
            console.log(`[VectorDB] Processing for "${diaryName}" is already in progress. Skipping.`);
            return;
        }

        console.log(`[VectorDB] Scheduling background processing for "${diaryName}".`);
        this.activeWorkers.add(diaryName);

        const worker = new Worker(path.resolve(__dirname, 'vectorizationWorker.js'), {
            workerData: {
                diaryName,
                config: {
                    apiKey: this.apiKey,
                    apiUrl: this.apiUrl,
                    embeddingModel: this.embeddingModel,
                }
            }
        });

        worker.on('message', (message) => {
            if (message.status === 'success') {
                this.manifest[message.diaryName] = message.fileHashes;
                this.saveManifest(); // This is async but we can fire-and-forget
                console.log(`[VectorDB] Successfully updated index for "${message.diaryName}" from worker.`);
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
            } else {
                console.log(`[VectorDB] Worker for "${diaryName}" finished successfully.`);
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
            
            return result.neighbors.map(neighborId => chunkMap[neighborId]).filter(Boolean);
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
    const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));

    let allChunks = [];
    let chunkMetadata = [];
    const fileHashes = {};

    for (const file of txtFiles) {
        const filePath = path.join(diaryPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        fileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
        const chunks = chunkText(content);
        allChunks.push(...chunks);
        chunks.forEach(chunk => chunkMetadata.push({ sourceFile: file, text: chunk }));
    }

    if (allChunks.length === 0) {
        console.log(`[VectorDB][Worker] Diary book "${diaryName}" is empty. Skipping.`);
        return fileHashes;
    }

    console.log(`[VectorDB][Worker] "${diaryName}" has ${allChunks.length} text chunks. Fetching embeddings...`);
    const vectors = await getEmbeddingsInWorker(allChunks, config);

    if (vectors.length !== allChunks.length) {
        console.error(`[VectorDB][Worker] Embedding failed or vector count mismatch for "${diaryName}". Aborting.`);
        return null;
    }

    const dimensions = vectors[0].length;
    const M = 32; // 每个节点的最大连接数 (推荐范围 16-48)
    const efConstruction = 400; // 构建图时的搜索范围 (推荐范围 200-500)
    const index = new HierarchicalNSW('l2', dimensions);

    // 使用更详细的参数来初始化索引
    index.initIndex(allChunks.length, M, efConstruction);

    vectors.forEach((vector, i) => index.addPoint(vector, i));

    const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
    const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
    const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

    const chunkMap = {};
    chunkMetadata.forEach((meta, i) => {
        chunkMap[i] = meta;
    });

    await index.writeIndex(indexPath);
    await fs.writeFile(mapPath, JSON.stringify(chunkMap, null, 2));

    console.log(`[VectorDB][Worker] Index for "${diaryName}" created and saved successfully.`);
    // Note: The worker does not interact with the main thread's in-memory cache directly.
    return fileHashes;
}


module.exports = { VectorDBManager, processSingleDiaryBookInWorker };