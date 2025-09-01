// vectorizationWorker.js
const { parentPort, workerData } = require('worker_threads');

// 强制清除TextChunker模块缓存，确保使用最新版本
const textChunkerPath = require.resolve('./TextChunker.js');
if (require.cache[textChunkerPath]) {
    delete require.cache[textChunkerPath];
}

// We only import the processing function, not the whole class.
const { processSingleDiaryBookInWorker } = require('./VectorDBManager.js');

/**
 * This worker is responsible for processing a single diary book in the background
 * to avoid blocking the main server's event loop. It's a stateless worker
 * that receives all necessary data and configuration from the main thread.
 */
async function run() {
    if (!parentPort) return;

    const { task, diaryName, config, chunksToAdd } = workerData;

    try {
        switch (task) {
            case 'fullRebuild':
                if (!diaryName || !config) throw new Error('Worker (fullRebuild) started without required diaryName or config.');
                console.log(`[VectorDB][Worker] Starting full rebuild for: ${diaryName}`);
                const newManifestEntry = await processSingleDiaryBookInWorker(diaryName, config);
                if (newManifestEntry) {
                    parentPort.postMessage({ status: 'success', task: 'fullRebuild', diaryName, newManifestEntry });
                } else {
                    throw new Error('Full rebuild processing returned null or undefined manifest entry.');
                }
                break;

            case 'incrementalUpdate':
                if (!diaryName || !config || !chunksToAdd) throw new Error('Worker (incrementalUpdate) started without required data.');
                console.log(`[VectorDB][Worker] Starting incremental update for ${diaryName}: ${chunksToAdd.length} chunks to add.`);
                const newVectorsData = await processIncrementalUpdateInWorker(chunksToAdd, config);
                if (newVectorsData) {
                    parentPort.postMessage({ status: 'success', task: 'incrementalUpdate', diaryName, newVectorsData });
                } else {
                    throw new Error('Incremental update processing returned null data.');
                }
                break;

            default:
                throw new Error(`Unknown task type received: ${task}`);
        }
    } catch (error) {
        console.error(`[VectorDB][Worker] Error during task "${task}" for "${diaryName}":`, error);
        parentPort.postMessage({
            status: 'error',
            task: task,
            diaryName: diaryName,
            error: error.message,
            stack: error.stack
        });
    }
}

run();