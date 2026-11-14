'use strict';

function failure(message, code = 'URLFETCH_CANCELLED') {
    return Object.assign(new Error(message), { code });
}

class BrowserPool {
    constructor({ maxPages = 5, maxQueue = 100, queueTimeoutMs = 90000,
        executionTimeoutMs = 60000, idleMs = 30000 } = {}) {
        this.maxPages = maxPages;
        this.maxQueue = maxQueue;
        this.queueTimeoutMs = queueTimeoutMs;
        this.executionTimeoutMs = executionTimeoutMs;
        this.idleMs = idleMs;
        this.entries = new Map();
        this.queue = [];
        this.active = new Set();
        this.closed = false;
    }

    acquire(key, open, signal) {
        if (this.closed) return Promise.reject(failure('UrlFetch 服务正在关闭'));
        if (signal?.aborted) return Promise.reject(signal.reason || failure('请求已取消'));
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(failure('UrlFetch 等待队列已满', 'URLFETCH_QUEUE_FULL'));
        }
        return new Promise((resolve, reject) => {
            const job = { key, open, signal, resolve, reject, page: null, entry: null };
            const cancel = () => {
                const index = this.queue.indexOf(job);
                if (index < 0) return;
                this.queue.splice(index, 1);
                this.cleanWait(job);
                reject(signal?.reason || failure('队列请求已取消'));
            };
            job.cancel = cancel;
            signal?.addEventListener('abort', cancel, { once: true });
            job.timer = setTimeout(() => {
                const index = this.queue.indexOf(job);
                if (index < 0) return;
                this.queue.splice(index, 1);
                this.cleanWait(job);
                reject(failure('UrlFetch 排队等待超时', 'URLFETCH_QUEUE_TIMEOUT'));
            }, this.queueTimeoutMs);
            this.queue.push(job);
            this.pump();
        });
    }

    cleanWait(job) {
        clearTimeout(job.timer);
        job.signal?.removeEventListener('abort', job.cancel);
    }

    pump() {
        while (!this.closed && this.active.size < this.maxPages && this.queue.length) {
            const job = this.queue.shift();
            this.cleanWait(job);
            this.active.add(job);
            job.done = this.start(job);
        }
    }

    async start(job) {
        let abort;
        let pageClose = null;
        const closePage = () => {
            if (!job.page) return Promise.resolve();
            if (!pageClose) pageClose = job.page.close().catch(() => {});
            return pageClose;
        };
        let released = false;
        let resolveRelease;
        const releasedPromise = new Promise(resolve => { resolveRelease = resolve; });
        job.release = async () => {
            if (released) return releasedPromise;
            released = true;
            clearTimeout(job.executionTimer);
            job.signal?.removeEventListener('abort', abort);
            await closePage();
            if (job.entry) {
                job.entry.users--;
                this.scheduleIdle(job.key, job.entry);
            }
            this.active.delete(job);
            resolveRelease();
            this.pump();
        };
        abort = () => {
            job.cancelled = job.signal?.reason || failure('页面请求已取消');
            // Keep the slot until an in-flight newPage/open has settled.
            closePage();
            job.reject(job.cancelled);
        };
        job.abort = abort;
        job.signal?.addEventListener('abort', abort, { once: true });
        if (job.signal?.aborted) abort();
        try {
            if (job.cancelled) throw job.cancelled;
            let entry = this.entries.get(job.key);
            if (entry?.close) {
                await entry.close;
                entry = this.entries.get(job.key);
            }
            if (this.closed || job.cancelled) throw job.cancelled || failure('服务已关闭');
            if (!entry) {
                entry = { users: 0, timer: null, close: null };
                this.entries.set(job.key, entry);
                entry.ready = Promise.resolve().then(job.open).then(resource => {
                    entry.resource = resource;
                    resource.browser.once?.('disconnected', () => {
                        clearTimeout(entry.timer);
                        if (this.entries.get(job.key) === entry) this.entries.delete(job.key);
                    });
                    return resource;
                }).catch(error => {
                    if (this.entries.get(job.key) === entry) this.entries.delete(job.key);
                    throw error;
                });
            }
            job.entry = entry;
            entry.users++;
            clearTimeout(entry.timer);
            const resource = await entry.ready;
            if (this.closed || job.cancelled) throw job.cancelled || failure('服务已关闭');
            job.page = await resource.browser.newPage();
            if (this.closed || job.cancelled) throw job.cancelled || failure('服务已关闭');
            job.executionTimer = setTimeout(() => {
                job.cancelled = failure('UrlFetch 页面执行超时', 'URLFETCH_PAGE_TIMEOUT');
                closePage();
                // Once handed to the caller, its finally releases the slot.
            }, this.executionTimeoutMs);
            job.resolve({
                browser: resource.browser,
                page: job.page,
                release: job.release,
                throwIfCancelled: () => {
                    if (job.cancelled) throw job.cancelled;
                }
            });
            await releasedPromise;
        } catch (error) {
            job.reject(error);
            await job.release();
        }
    }

    scheduleIdle(key, entry) {
        if (entry.users || this.closed) return;
        entry.timer = setTimeout(() => {
            if (entry.users || this.closed) return;
            this.closeEntry(key, entry).catch(error => {
                console.error('[UrlFetch pool] idle close:', error.message);
            });
        }, this.idleMs);
        entry.timer.unref?.();
    }

    async closeEntry(key, entry) {
        if (entry.close) return entry.close;
        clearTimeout(entry.timer);
        // Keep a closing entry discoverable until close completes; callers must
        // await closing before launching another process for the same profile.
        entry.close = (async () => {
            try {
                const resource = await entry.ready;
                await resource.close();
            } finally {
                if (this.entries.get(key) === entry) this.entries.delete(key);
            }
        })();
        return entry.close;
    }

    async lease(key, open, signal) {
        return this.acquire(key, open, signal);
    }

    async shutdown() {
        this.closed = true;
        for (const job of this.queue.splice(0)) {
            this.cleanWait(job);
            job.reject(failure('UrlFetch 服务已关闭'));
        }
        for (const job of this.active) job.abort?.();
        // Close resources to unblock navigation, then await each lease owner.
        await Promise.allSettled(Array.from(this.entries, ([key, entry]) => this.closeEntry(key, entry)));
        await Promise.allSettled(Array.from(this.active, job => job.done));
    }

    stats() {
        return { active: this.active.size, queued: this.queue.length, browsers: this.entries.size };
    }
}

module.exports = { BrowserPool };