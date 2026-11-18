'use strict';

const { parentPort } = require('worker_threads');
const fuzzy = require('./OneRingFuzzy.js');

if (!parentPort) {
    throw new Error('OneRingFuzzyWorker must be started as a worker thread.');
}

parentPort.on('message', (message) => {
    const { id, type, payload } = message || {};
    try {
        if (type === 'similarity') {
            const { a, b } = payload || {};
            parentPort.postMessage({ id, ok: true, result: fuzzy.similarity(a, b) });
            return;
        }

        if (type === 'similarityMany') {
            const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
            const result = pairs.map(pair => fuzzy.similarity(pair?.a, pair?.b));
            parentPort.postMessage({ id, ok: true, result });
            return;
        }

        parentPort.postMessage({ id, ok: false, error: `Unsupported fuzzy worker task type: ${type}` });
    } catch (error) {
        parentPort.postMessage({ id, ok: false, error: error.message || String(error) });
    }
});