// VectorDBManager.js
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
                    console.log(`[VectorDB] Changes detected in "${diaryName}". Starting index update...`);
                    const newFileHashes = await this.processDiaryBook(diaryName);
                    if (newFileHashes) {
                        this.manifest[diaryName] = newFileHashes;
                        await this.saveManifest();
                        console.log(`[VectorDB] Manifest for "${diaryName}" has been updated.`);
                    }
                } else {
                    console.log(`[VectorDB] "${diaryName}" is up-to-date. Skipping.`);
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
        // Dynamically import node-fetch as you've configured
        const { default: fetch } = await import('node-fetch');
        const allVectors = [];
        const batchSize = parseInt(process.env.WhitelistEmbeddingModelList) || 5;
        
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            try {
                const response = await fetch(`${this.apiUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify({
                        model: this.embeddingModel,
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
                console.log(`[VectorDB] Successfully processed a batch of ${batch.length} text chunks.`);
            } catch (error) {
                console.error('[VectorDB] Failed to call Embedding API:', error);
                // To maintain array alignment, push nulls for the failed batch
                allVectors.push(...Array(batch.length).fill(null)); 
            }
        }
        return allVectors.filter(v => v !== null);
    }
    
    /**
     * Processes all .txt files in a diary book directory, creates a vector index, and saves it.
     * @param {string} diaryName - The name of the diary book to process.
     * @returns {Promise<object|null>} - An object containing file hashes, or null on failure.
     */
    async processDiaryBook(diaryName) {
        const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
        const files = await fs.readdir(diaryPath);
        const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));

        let allChunks = [];
        let chunkMetadata = []; // { sourceFile: string, text: string }
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
            console.log(`[VectorDB] Diary book "${diaryName}" is empty. Skipping.`);
            return fileHashes; // Return empty hashes to update manifest correctly
        }

        console.log(`[VectorDB] "${diaryName}" has ${allChunks.length} text chunks. Fetching embeddings...`);
        const vectors = await this.getEmbeddings(allChunks);

        if (vectors.length === 0 || vectors.length !== allChunks.length) {
            console.error(`[VectorDB] Embedding failed or vector count mismatch for "${diaryName}". Index creation aborted.`);
            return null;
        }

        const dimensions = vectors[0].length;
        const index = new HierarchicalNSW('l2', dimensions);
        index.initIndex(allChunks.length);
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
        
        console.log(`[VectorDB] Index for "${diaryName}" has been successfully created and saved.`);
        this.indices.set(diaryName, index);
        this.chunkMaps.set(diaryName, chunkMap);

        return fileHashes;
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

        const handleFileChange = async (filePath) => {
            console.log(`[VectorDB] File change detected: ${filePath}`);
            const diaryName = path.basename(path.dirname(filePath));
            console.log(`[VectorDB] Rebuilding index for "${diaryName}" due to file change...`);
            const newFileHashes = await this.processDiaryBook(diaryName);
            if (newFileHashes) {
                this.manifest[diaryName] = newFileHashes;
                await this.saveManifest();
                console.log(`[VectorDB] Manifest for "${diaryName}" updated after real-time change.`);
            }
        };

        watcher
            .on('add', handleFileChange)
            .on('change', handleFileChange)
            .on('unlink', handleFileChange);
    }

    /**
     * Searches the vector index for a given diary book.
     * @param {string} diaryName - The name of the diary book to search in.
     * @param {number[]} queryVector - The vector representation of the search query.
     * @param {number} [k=3] - The number of nearest neighbors to return.
     * @returns {Promise<object[]>} - An array of the most relevant chunk objects.
     */
    async search(diaryName, queryVector, k = 3) {
        if (!this.indices.has(diaryName)) {
            try {
                const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
                const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
                const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

                await fs.access(indexPath);
                await fs.access(mapPath);

                const indexData = await fs.readFile(indexPath);
                // IMPORTANT: The dimension must match your embedding model's output.
                // You might want to make this configurable.
                const dimensions = queryVector.length;
                const index = new HierarchicalNSW('l2', dimensions);
                index.readIndexSync(indexData);
                
                const mapData = await fs.readFile(mapPath, 'utf-8');
                
                this.indices.set(diaryName, index);
                this.chunkMaps.set(diaryName, JSON.parse(mapData));
                console.log(`[VectorDB] Lazily loaded index for "${diaryName}" into memory.`);
            } catch (error) {
                 console.error(`[VectorDB] Failed to load index for "${diaryName}":`, error);
                 return [];
            }
        }
        
        const index = this.indices.get(diaryName);
        const chunkMap = this.chunkMaps.get(diaryName);
        if (!index || !chunkMap) return [];
        
        const result = index.searchKnn(queryVector, k);
        
        return result.neighbors.map(neighborId => chunkMap[neighborId]).filter(Boolean);
    }
}

module.exports = { VectorDBManager };