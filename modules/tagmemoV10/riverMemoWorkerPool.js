'use strict';

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 120_000;

class RiverMemoWorkerPool {
    constructor(options = {}) {
        this.workerPath = options.workerPath
            || path.join(__dirname, 'riverMemoWorker.js');
        const cpuCount = Math.max(1, os.cpus()?.length || 1);
        const configuredSize = Number.parseInt(
            process.env.RIVERMEMO_WORKER_POOL_SIZE || options.size || '',
            10
        );
        this.size = Number.isFinite(configuredSize) && configuredSize > 0
            ? Math.min(configuredSize, cpuCount)
            : Math.min(2, cpuCount);
        const configuredTimeout = Number.parseInt(
            process.env.RIVERMEMO_WORKER_TIMEOUT_MS || options.timeoutMs || '',
            10
        );
        this.timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : DEFAULT_TIMEOUT_MS;

        this.workers = [];
        this.idleWorkers = [];
        this.queue = [];
        this.nextTaskId = 1;
        this.started = false;
        this.closed = false;
    }

    start() {
        if (this.started) return;
        if (this.closed) this._reopen();
        this.started = true;
        for (let index = 0; index < this.size; index++) {
            this._createWorker();
        }
        console.log(
            `[RiverMemoWorkerPool] Started ${this.size} persistent worker(s), ` +
            `timeout=${this.timeoutMs}ms.`
        );
    }

    run(payload) {
        if (this.closed) this._reopen();
        this.start();
        return new Promise((resolve, reject) => {
            this.queue.push({ payload, resolve, reject });
            this._drain();
        });
    }

    async close() {
        if (this.closed && this.workers.length === 0) return;
        this.closed = true;
        this.started = false;

        const queued = this.queue.splice(0);
        for (const task of queued) {
            task.reject(new Error('RiverMemo worker pool closed before task execution.'));
        }

        const workers = this.workers.splice(0);
        this.idleWorkers = [];
        for (const worker of workers) {
            this._clearWorkerTask(
                worker,
                new Error('RiverMemo worker pool closed during task execution.')
            );
        }
        await Promise.allSettled(workers.map(worker => worker.terminate()));
        console.log('[RiverMemoWorkerPool] All workers terminated.');
    }

    _reopen() {
        this.closed = false;
        this.started = false;
        this.workers = [];
        this.idleWorkers = [];
        this.queue = [];
    }

    _createWorker() {
        const worker = new Worker(this.workerPath);
        worker.__riverMemoTask = null;

        worker.on('message', message => this._handleMessage(worker, message));
        worker.on('error', error => this._handleFailure(worker, error));
        worker.on('exit', code => {
            const error = code === 0
                ? new Error('RiverMemo worker exited.')
                : new Error(`RiverMemo worker exited with code ${code}.`);
            this._handleFailure(worker, error, true);
        });

        this.workers.push(worker);
        this.idleWorkers.push(worker);
        this._drain();
    }

    _handleMessage(worker, message) {
        const task = worker.__riverMemoTask;
        if (!task || task.id !== message?.id) return;

        this._clearWorkerTask(worker);
        if (message.ok) {
            task.resolve(message.result);
        } else {
            const error = new Error(message.error?.message || 'RiverMemo worker task failed.');
            error.code = message.error?.code || 'RIVERMEMO_WORKER_TASK_FAILED';
            error.stack = message.error?.stack || error.stack;
            task.reject(error);
        }

        if (!this.closed && this.workers.includes(worker)) {
            this.idleWorkers.push(worker);
            this._drain();
        }
    }

    _handleFailure(worker, error, fromExit = false) {
        const wasManaged = this.workers.includes(worker);
        this._clearWorkerTask(worker, error);
        this.workers = this.workers.filter(item => item !== worker);
        this.idleWorkers = this.idleWorkers.filter(item => item !== worker);

        if (!fromExit) worker.terminate().catch(() => {});
        if (!this.closed && wasManaged && this.workers.length < this.size) {
            this._createWorker();
        }
    }

    _clearWorkerTask(worker, error = null) {
        const task = worker.__riverMemoTask;
        if (!task) return;
        worker.__riverMemoTask = null;
        clearTimeout(task.timer);
        if (error) task.reject(error);
    }

    _drain() {
        while (!this.closed && this.queue.length > 0 && this.idleWorkers.length > 0) {
            const worker = this.idleWorkers.shift();
            if (!worker || !this.workers.includes(worker)) continue;

            const task = this.queue.shift();
            const id = this.nextTaskId++;
            const timer = setTimeout(() => {
                const error = new Error(
                    `RiverMemo worker task timed out after ${this.timeoutMs}ms.`
                );
                error.code = 'RIVERMEMO_WORKER_TIMEOUT';
                this._handleFailure(worker, error);
            }, this.timeoutMs);

            worker.__riverMemoTask = { ...task, id, timer };
            worker.postMessage({ id, payload: task.payload });
        }
    }
}

module.exports = RiverMemoWorkerPool;