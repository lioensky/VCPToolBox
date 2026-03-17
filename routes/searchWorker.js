const { parentPort, workerData } = require('worker_threads');
const fs = require('fs').promises;

/**
 * 搜索工作线程
 * 负责读取文件内容并进行关键词匹配
 */
async function run() {
    const { files, searchTerms, previewLength } = workerData;
    const results = [];

    for (const file of files) {
        try {
            // 读取文件内容
            const content = await fs.readFile(file.path, 'utf-8');
            const lower = content.toLowerCase();

            // 检查是否包含所有关键词
            if (searchTerms.every(t => lower.includes(t))) {
                results.push({
                    name: file.name,
                    folderName: file.folderName,
                    lastModified: file.lastModified,
                    preview: content.substring(0, previewLength).replace(/\n/g, ' ') +
                             (content.length > previewLength ? '...' : ''),
                });
            }
        } catch (err) {
            // 忽略读取失败的文件（可能在搜索过程中被删除或权限不足）
        }
    }

    // 返回结果给主线程
    parentPort.postMessage(results);
}

run().catch(err => {
    console.error('[SearchWorker] Error:', err);
    process.exit(1);
});