'use strict';

// 双曲场图的工作线程。读快照、读向量、算距离都在这里，不占后端主线程。

const { parentPort, workerData } = require('node:worker_threads');
const { createAtlas } = require('./atlas');

let atlas = null;

parentPort.on('message', ({ id, pathname, search }) => {
    try {
        if (!atlas) atlas = createAtlas(workerData);
        const body = JSON.stringify(atlas.handle(pathname, new URLSearchParams(search || '')));
        parentPort.postMessage({ id, ok: true, body });
    } catch (error) {
        parentPort.postMessage({ id, ok: false, status: Number.isInteger(error.status) ? error.status : 500, message: error.message });
    }
});
