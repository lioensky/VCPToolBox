'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NativeKnowledgeRuntime, VexusIndex, VexusWatcher } = require('../rust-vexus-lite');
const KnowledgeBaseFileWatcher = require('../modules/knowledgeBase/fileWatcher');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileCount = 7000;

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbm-watch-backpressure-'));
    const notes = path.join(root, 'notes');
    fs.mkdirSync(notes);
    for (let index = 0; index < fileCount; index++) {
        fs.writeFileSync(path.join(notes, `note-${index}.txt`), 'body');
    }
    return { root, notes };
}

async function collect(drain, seen, generations, count = fileCount) {
    const deadline = Date.now() + 15000;
    while (seen.size < count && Date.now() < deadline) {
        for (const event of drain()) {
            assert.notEqual(event.event, 'overflow', 'scan must not trigger overflow recovery');
            assert.equal(event.event, 'add');
            assert.equal(seen.has(event.path), false, 'static paths must be emitted once');
            seen.add(event.path);
            generations.add(event.generation);
        }
        await sleep(100);
    }
    assert.equal(seen.size, count, 'scan must deliver every path despite queue backpressure');
}

test('native initial scan delivers more than queue capacity without loss or overflow', async () => {
    const { root, notes } = fixture();
    const watcher = new VexusWatcher();
    try {
        watcher.startWatch({
            rootPath: notes, ignoreFolders: [], ignorePrefixes: [],
            ignoreSuffixes: [], initialScan: true
        });
        // No consumer while the producer fills the bounded queue.
        await sleep(500);
        const seen = new Set();
        const generations = new Set();
        await collect(() => watcher.drainEvents(256), seen, generations);
        assert.equal(generations.size, 1);
        await sleep(300);
        assert.deepEqual(watcher.drainEvents(256), []);
    } finally {
        watcher.stopWatch();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('production startup reconciliation converges once with 7000 static files', async () => {
    const { root, notes } = fixture();
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(768, 16));
    const dbPath = path.join(root, 'test.sqlite');
    const owner = {
        dbPath,
        config: { rootPath: notes, fullScanOnStartup: true, maxBatchSize: 50 },
        nativeKnowledgeRuntime: runtime,
        watcherPathGenerations: new Map(),
        pendingFiles: new Set(),
        pendingDeletes: new Set(),
        staleWatcherEventsDropped: 0,
        _flushBatch() {},
        _scheduleBatch() {},
        _queueDelete() {}
    };
    const watcher = new KnowledgeBaseFileWatcher({ owner });
    const seen = new Set();
    const generations = new Set();
    let overflow = 0;
    let duplicates = 0;
    const handle = watcher._handleRustEvent.bind(watcher);
    watcher._handleRustEvent = event => {
        if (event.event === 'overflow') {
            overflow++;
        } else {
            if (seen.has(event.path)) duplicates++;
            seen.add(event.path);
            generations.add(event.generation);
        }
        handle(event);
    };
    try {
        runtime.openAndInitStore(dbPath);
        watcher.start();
        const deadline = Date.now() + 15000;
        while (seen.size < fileCount && Date.now() < deadline) await sleep(100);
        assert.equal(seen.size, fileCount);
        await sleep(500);
        assert.equal(overflow, 0);
        assert.equal(duplicates, 0);
        assert.equal(generations.size, 1);
        assert.equal(owner.pendingFiles.size, fileCount);
        assert.equal(owner.staleWatcherEventsDropped, 0);
    } finally {
        await watcher.stop();
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('stopping a scan with a full queue does not require a consumer', async () => {
    const { root, notes } = fixture();
    const watcher = new VexusWatcher();
    try {
        watcher.startWatch({
            rootPath: notes, ignoreFolders: [], ignorePrefixes: [],
            ignoreSuffixes: [], initialScan: true
        });
        await sleep(500);
        const started = Date.now();
        watcher.stopWatch();
        assert.ok(Date.now() - started < 2000, 'stop must cancel scan backpressure');
        assert.deepEqual(watcher.drainEvents(256), []);
    } finally {
        watcher.stopWatch();
        fs.rmSync(root, { recursive: true, force: true });
    }
});