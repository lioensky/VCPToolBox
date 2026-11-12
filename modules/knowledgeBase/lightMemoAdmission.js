'use strict';

class LightMemoAdmission {
    constructor({ concurrency = 8, maxQueue = 256, timeoutMs = 30000 } = {}) {
        this.concurrency = concurrency;
        this.maxQueue = maxQueue;
        this.timeoutMs = timeoutMs;
        this.active = 0;
        this.queue = [];
    }

    acquire(signal) {
        if (signal?.aborted) return Promise.reject(signal.reason || new Error('LIGHTMEMO_ABORTED'));
        if (this.active < this.concurrency) {
            this.active++;
            return Promise.resolve(this._release());
        }
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new Error('LIGHTMEMO_QUEUE_FULL'));
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, cleanup: null };
            const cancel = error => {
                const index = this.queue.indexOf(entry);
                if (index < 0) return;
                this.queue.splice(index, 1);
                entry.cleanup();
                reject(error);
            };
            const abort = () => cancel(signal.reason || new Error('LIGHTMEMO_ABORTED'));
            const timer = setTimeout(() => cancel(new Error('LIGHTMEMO_QUEUE_TIMEOUT')), this.timeoutMs);
            entry.cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            };
            this.queue.push(entry);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    }

    _release() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this.queue.shift();
            if (next) {
                next.cleanup();
                next.resolve(this._release());
            } else {
                this.active--;
            }
        };
    }
}

const gates = new WeakMap();
function gateFor(owner) {
    if (!gates.has(owner)) gates.set(owner, new LightMemoAdmission());
    return gates.get(owner);
}
module.exports = { LightMemoAdmission, gateFor };