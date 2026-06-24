'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TASK_TIMEOUT_MS = 30_000;

class OneRingFuzzyWorkerPool {
    constructor(options = {}) {
        this.workerPath = options.workerPath || path.join(__dirname, 'OneRingFuzzyWorker.js');
        const cpuCount = Math.max(1, os.cpus()?.length || 1);
        const configuredSize = Number.parseInt(process.env.ONERING_FUZZY_WORKER_POOL_SIZE || options.size || '', 10);
        this.size = Number.isFinite(configuredSize) && configuredSize > 0
            ? configuredSize
            : Math.min(2, cpuCount);
        this.timeoutMs = Number.parseInt(process.env.ONERING_FUZZY_WORKER_TIMEOUT_MS || options.timeoutMs || DEFAULT_TASK_TIMEOUT_MS, 10);
        this.workers = [];
        this.idleWorkers = [];
        this.queue = [];
        this.nextId = 1;
        this.closed = false;
        this.started = false;
    }

    start() {
        if (this.started) return;
        if (this.closed) {
            this.reopen();
        }
        this.started = true;
        for (let i = 0; i < this.size; i++) {
            this._createWorker();
        }
    }

    reopen() {
        if (!this.closed) return;
        this.closed = false;
        this.started = false;
        this.workers = [];
        this.idleWorkers = [];
        this.queue = [];
    }

    similarity(a, b) {
        return this.run('similarity', { a, b });
    }

    similarityMany(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) return Promise.resolve([]);
        return this.run('similarityMany', { pairs });
    }

    run(type, payload) {
        if (this.closed) {
            this.reopen();
        }
        this.start();
        return new Promise((resolve, reject) => {
            this.queue.push({ type, payload, resolve, reject });
            this._drain();
        });
    }

    close() {
        if (this.closed && !this.started && this.workers.length === 0) return;
        this.closed = true;
        this.started = false;
        const pending = this.queue.splice(0);
        for (const task of pending) {
            task.reject(new Error('OneRing fuzzy worker pool closed before task execution.'));
        }

        for (const worker of this.workers) {
            this._clearWorkerTask(worker, new Error('OneRing fuzzy worker pool closed.'));
            worker.terminate().catch(() => {});
        }

        this.workers = [];
        this.idleWorkers = [];
    }

    _createWorker() {
        const worker = new Worker(this.workerPath);
        worker.__oneRingTask = null;

        worker.on('message', (message) => this._handleWorkerMessage(worker, message));
        worker.on('error', (error) => this._handleWorkerFailure(worker, error));
        worker.on('exit', (code) => {
            const error = code === 0
                ? new Error('OneRing fuzzy worker exited.')
                : new Error(`OneRing fuzzy worker exited with code ${code}.`);
            this._handleWorkerFailure(worker, error, true);
        });

        this.workers.push(worker);
        this.idleWorkers.push(worker);
        this._drain();
    }

    _handleWorkerMessage(worker, message) {
        const task = worker.__oneRingTask;
        if (!task || task.id !== message?.id) return;

        this._clearWorkerTask(worker);
        if (message.ok) {
            task.resolve(message.result);
        } else {
            task.reject(new Error(message.error || 'OneRing fuzzy worker task failed.'));
        }

        if (!this.closed && this.workers.includes(worker)) {
            this.idleWorkers.push(worker);
            this._drain();
        }
    }

    _handleWorkerFailure(worker, error, fromExit = false) {
        this._clearWorkerTask(worker, error);
        this.workers = this.workers.filter(item => item !== worker);
        this.idleWorkers = this.idleWorkers.filter(item => item !== worker);

        if (!fromExit) {
            worker.terminate().catch(() => {});
        }

        if (!this.closed && this.workers.length < this.size) {
            this._createWorker();
        }
    }

    _clearWorkerTask(worker, error = null) {
        const task = worker.__oneRingTask;
        if (!task) return;
        worker.__oneRingTask = null;
        clearTimeout(task.timer);
        if (error) task.reject(error);
    }

    _drain() {
        while (!this.closed && this.queue.length > 0 && this.idleWorkers.length > 0) {
            const worker = this.idleWorkers.shift();
            if (!worker || !this.workers.includes(worker)) continue;

            const task = this.queue.shift();
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this._handleWorkerFailure(worker, new Error(`OneRing fuzzy worker task timed out after ${this.timeoutMs}ms.`));
            }, Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : DEFAULT_TASK_TIMEOUT_MS);

            worker.__oneRingTask = { ...task, id, timer };
            worker.postMessage({ id, type: task.type, payload: task.payload });
        }
    }
}

module.exports = new OneRingFuzzyWorkerPool();
module.exports.OneRingFuzzyWorkerPool = OneRingFuzzyWorkerPool;