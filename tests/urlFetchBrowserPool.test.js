'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserPool } = require('../Plugin/UrlFetch/browserPool');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
    let opens = 0, pages = 0, peak = 0, closes = 0;
    const pool = new BrowserPool({ idleMs: 10000, ...options });
    const open = async () => {
        opens++;
        await delay(5);
        return {
            browser: {
                async newPage() {
                    pages++; peak = Math.max(peak, pages);
                    let closed = false;
                    return { async close() { if (!closed) { closed = true; pages--; } } };
                }
            },
            async close() { closes++; }
        };
    };
    return { pool, open, counts: () => ({ opens, pages, peak, closes }) };
}
test('ten requests share one launch and never exceed five page leases', async () => {
    const f = fixture();
    const completed = [];
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
        const lease = await f.pool.lease('same-profile', f.open);
        try { await delay(10); completed.push(i); }
        finally { await lease.release(); }
    }));
    assert.equal(f.counts().opens, 1);
    assert.equal(f.counts().peak, 5);
    assert.equal(completed.length, 10);
    assert.equal(f.pool.stats().active, 0);
    await f.pool.shutdown();
    assert.equal(f.counts().closes, 1);
});
test('queued cancellation removes waiter without creating a page', async () => {
    const f = fixture({ maxPages: 1 });
    const first = await f.pool.lease('key', f.open);
    const controller = new AbortController();
    const rejected = assert.rejects(f.pool.lease('key', f.open, controller.signal));
    controller.abort();
    await rejected;
    assert.equal(f.pool.stats().queued, 0);
    await first.release();
    await f.pool.shutdown();
    assert.equal(f.counts().peak, 1);
});
test('active cancellation closes only its page; lease owner releases slot', async () => {
    const f = fixture();
    const controller = new AbortController();
    const a = await f.pool.lease('key', f.open, controller.signal);
    const b = await f.pool.lease('key', f.open);
    controller.abort();
    await delay(1);
    assert.equal(f.counts().pages, 1);
    assert.throws(a.throwIfCancelled);
    await a.release(); await b.release(); await f.pool.shutdown();
});
test('launch failure releases slot and permits retry', async () => {
    const f = fixture({ maxPages: 1 });
    await assert.rejects(f.pool.lease('key', async () => { throw Error('launch failed'); }));
    const lease = await f.pool.lease('key', f.open);
    await lease.release(); await f.pool.shutdown();
    assert.equal(f.pool.stats().active, 0);
});
test('shutdown during launch collects late browser and rejects queued work', async () => {
    const f = fixture({ maxPages: 1 });
    const a = assert.rejects(f.pool.lease('key', f.open));
    const b = assert.rejects(f.pool.lease('key', f.open));
    await f.pool.shutdown();
    await Promise.all([a, b]);
    assert.equal(f.pool.stats().active, 0);
    assert.equal(f.counts().pages, 0);
});
test('queue timeout is distinct from page execution timeout', async () => {
    const f = fixture({ maxPages: 1, queueTimeoutMs: 15 });
    const a = await f.pool.lease('key', f.open);
    await assert.rejects(f.pool.lease('key', f.open), { code: 'URLFETCH_QUEUE_TIMEOUT' });
    await a.release(); await f.pool.shutdown();
});
test('idle close and subsequent lease never overlap resource lifetime', async () => {
    const f = fixture({ idleMs: 5 });
    const a = await f.pool.lease('key', f.open);
    await a.release(); await delay(20);
    const b = await f.pool.lease('key', f.open);
    assert.equal(f.counts().opens, 2);
    await b.release(); await f.pool.shutdown();
});
test('execution timeout closes page and remains distinguishable to caller', async () => {
    const f = fixture({ executionTimeoutMs: 10 });
    const lease = await f.pool.lease('key', f.open);
    await delay(25);
    assert.throws(lease.throwIfCancelled, { code: 'URLFETCH_PAGE_TIMEOUT' });
    assert.equal(f.counts().pages, 0);
    await lease.release(); await f.pool.shutdown();
});
test('new work waits for slow idle close before relaunching same profile', async () => {
    let shutting = false, opens = 0;
    const pool = new BrowserPool({ idleMs: 5 });
    const open = async () => {
        assert.equal(shutting, false);
        opens++;
        return {
            browser: { async newPage() { return { async close() {} }; } },
            async close() { shutting = true; await delay(25); shutting = false; }
        };
    };
    const first = await pool.lease('key', open);
    await first.release();
    await delay(10);
    assert.equal(shutting, true);
    const second = await pool.lease('key', open);
    assert.equal(opens, 2);
    await second.release(); await pool.shutdown();
});