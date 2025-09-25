// vectorSearchWorker.js
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs').promises;
const { HierarchicalNSW } = require('hnswlib-node');

async function performSearch() {
    const { diaryName, queryVector, k, efSearch, vectorStorePath } = workerData;

    try {
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(vectorStorePath, `${safeFileNameBase}.bin`);
        const mapPath = path.join(vectorStorePath, `${safeFileNameBase}_map.json`);

        // 1. 加载索引和映射文件
        const index = new HierarchicalNSW('l2', queryVector.length);
        await index.readIndex(indexPath);
        
        const mapData = await fs.readFile(mapPath, 'utf-8');
        const chunkMap = JSON.parse(mapData);

        // 2. 验证索引状态
        if (index.getCurrentCount() === 0) {
            parentPort.postMessage({ status: 'success', results: [] });
            return;
        }

        // 3. 设置搜索参数并执行搜索
        if (typeof index.setEf === 'function') {
            index.setEf(efSearch);
        }
        const result = index.searchKnn(queryVector, k);

        if (!result || !result.neighbors) {
            throw new Error('Search returned invalid result.');
        }

        // 4. 整理并返回结果
        const searchResults = result.neighbors.map(label => chunkMap[label]).filter(Boolean);
        parentPort.postMessage({ status: 'success', results: searchResults });

    } catch (error) {
        parentPort.postMessage({ status: 'error', error: error.message });
    }
}

performSearch();