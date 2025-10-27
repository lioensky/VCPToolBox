// WorkerPool.js
const { Worker } = require('worker_threads');
const os = require('os');

/**
 * A simple and efficient worker thread pool.
 */
class WorkerPool {
    /**
     * @param {string} workerPath The path to the worker script.
     * @param {number} [maxWorkers=os.cpus().length] The maximum number of workers in the pool.
     */
    constructor(workerPath, maxWorkers = os.cpus().length) {
        if (!workerPath) {
            throw new Error('Worker path is required.');
        }
        this.workerPath = workerPath;
        this.maxWorkers = Math.max(1, maxWorkers);
        
        this.workers = [];
        this.queue = [];
        this.activeTasks = 0;

        console.log(`[WorkerPool] Initializing with up to ${this.maxWorkers} workers for ${workerPath}`);
    }

    /**
     * Creates a new worker and sets up its listeners.
     * @returns {Worker} The newly created worker.
     */
    createWorker() {
        const worker = new Worker(this.workerPath);

        worker.on('exit', (code) => {
            console.warn(`[WorkerPool] Worker exited with code ${code}.`);
            // Remove from pool and potentially replace it if needed.
            this.workers = this.workers.filter(w => w !== worker);
        });

        worker.on('error', (err) => {
            console.error('[WorkerPool] Worker encountered an error:', err);
            // The 'exit' event will likely follow, so we don't need to remove it here.
        });

        return worker;
    }

    /**
     * Executes a task with the given data in a worker thread.
     * @param {any} workerData The data to send to the worker.
     * @returns {Promise<any>} A promise that resolves with the worker's result.
     */
    execute(workerData) {
        return new Promise((resolve, reject) => {
            const task = { workerData, resolve, reject };
            this.queue.push(task);
            this.dispatch();
        });
    }

    /**
     * Dispatches tasks from the queue to available or new workers.
     */
    dispatch() {
        if (this.queue.length === 0 || this.activeTasks >= this.maxWorkers) {
            return;
        }

        // Find an idle worker first
        let worker = this.workers.find(w => !w.isBusy);

        // If no idle worker and we can create more, do so
        if (!worker && this.workers.length < this.maxWorkers) {
            worker = this.createWorker();
            this.workers.push(worker);
        }

        if (worker) {
            const task = this.queue.shift();
            this.runTask(worker, task);
        }
    }

    /**
     * Runs a specific task on a given worker.
     * @param {Worker} worker The worker to run the task on.
     * @param {object} task The task object containing data and promise handlers.
     */
    runTask(worker, task) {
        this.activeTasks++;
        worker.isBusy = true;

        const messageHandler = (message) => {
            task.resolve(message);
            cleanup();
        };

        const errorHandler = (error) => {
            task.reject(error);
            cleanup();
        };

        const cleanup = () => {
            worker.removeListener('message', messageHandler);
            worker.removeListener('error', errorHandler);
            
            worker.isBusy = false;
            this.activeTasks--;

            // If there are more tasks, dispatch them
            this.dispatch();
        };

        worker.once('message', messageHandler);
        worker.once('error', errorHandler);
        worker.postMessage(task.workerData);
    }

    /**
     * Gracefully terminates all workers in the pool.
     */
    async terminate() {
        console.log('[WorkerPool] Terminating worker pool...');
        await Promise.all(this.workers.map(worker => worker.terminate()));
        this.workers = [];
        console.log('[WorkerPool] All workers have been terminated.');
    }
}

module.exports = WorkerPool;