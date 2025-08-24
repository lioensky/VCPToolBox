// vectorizationWorker.js
const { parentPort, workerData } = require('worker_threads');
// We only import the processing function, not the whole class.
const { processSingleDiaryBookInWorker } = require('./VectorDBManager.js');

/**
 * This worker is responsible for processing a single diary book in the background
 * to avoid blocking the main server's event loop. It's a stateless worker
 * that receives all necessary data and configuration from the main thread.
 */
async function run() {
    if (!parentPort) return;

    // Receive diaryName and API config from the main thread
    const { diaryName, config } = workerData;
    if (!diaryName || !config) {
        if (parentPort) {
             parentPort.postMessage({ status: 'error', diaryName: diaryName || 'Unknown', error: 'Worker started without required diaryName or config.' });
        }
        return;
    }

    console.log(`[VectorDB][Worker] Starting background vectorization for: ${diaryName}`);

    try {
        // Use the stateless function to process the diary book.
        // This avoids creating a new VectorDBManager instance and its associated overhead.
        const fileHashes = await processSingleDiaryBookInWorker(diaryName, config);

        if (fileHashes) {
            parentPort.postMessage({
                status: 'success',
                diaryName: diaryName,
                fileHashes: fileHashes
            });
        } else {
             throw new Error('Processing returned null or undefined file hashes.');
        }

    } catch (error) {
        console.error(`[VectorDB][Worker] Unhandled error processing "${diaryName}":`, error);
        parentPort.postMessage({
            status: 'error',
            diaryName: diaryName,
            error: error.message,
            stack: error.stack // Include stack for better debugging
        });
    }
}

run();