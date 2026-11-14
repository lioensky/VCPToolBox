'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('live direct UrlFetch: ten independent requests, five slots, one browser', {
    skip: process.env.URLFETCH_LIVE_TEST !== '1', timeout: 60000
}, async () => {
    const service = require('../Plugin/UrlFetch/UrlFetch');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'urlfetch-pool-live-'));
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<html><head><title>Task ${req.url}</title></head><body><article><h1>Task ${req.url}</h1><p>${(`Unique task marker ${req.url}. This page is independent and must never be mixed with another request. `).repeat(8)}</p></article></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let peak = 0, peakQueue = 0, browsers = 0;
    let timer;
    try {
        await service.initialize({
            URLFETCH_BROWSER_FIRST: 'true',
            URLFETCH_PERSISTENT_PROFILE: 'true',
            URLFETCH_PROFILE_DIR: profile,
            URLFETCH_USE_MANAGED_CHROME: 'false'
        });
        timer = setInterval(() => {
            const state = service._poolStats();
            peak = Math.max(peak, state.active);
            peakQueue = Math.max(peakQueue, state.queued);
            browsers = Math.max(browsers, state.browsers);
        }, 10);
        const port = server.address().port;
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
            service.processToolCall({ url: `http://127.0.0.1:${port}/job-${i}-end` })));
        for (let i = 0; i < 10; i++) {
            const text = results[i].content.map(c => c.text || '').join('\n');
            assert.ok(text.includes(`Unique task marker /job-${i}-end`));
            for (let j = 0; j < 10; j++) {
                if (i !== j) assert.ok(!text.includes(`Unique task marker /job-${j}-end`));
            }
        }
        assert.equal(peak, 5);
        assert.equal(peakQueue, 5);
        assert.equal(browsers, 1);
        assert.equal(service._poolStats().active, 0);
        console.log('LIVE SUMMARY', JSON.stringify({ completed: results.length, peak, peakQueue, browsers }));
    } finally {
        clearInterval(timer);
        await service.shutdown();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
});