'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const Manager = require('../TDBKnowledge').constructor;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(100);
    }
    throw new Error(`Timed out: ${label}`);
}

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdb-watch-test-'));
    const manager = new Manager({
        rootPath: root, storePath: path.join(root, 'store'),
        extensions: ['.txt'], excludeFolders: [], fullScanOnStartup: false
    });
    manager.metaDb = new Database(':memory:');
    manager._initSchema();
    manager._startSafetyWatcher = () => {};
    const events = [];
    const originalHandler = manager._handleWatcherEvent.bind(manager);
    manager._handleWatcherEvent = (event, file, options) => {
        events.push({ event, file, options });
    };
    try {
        manager._startWatcher();
        assert.equal(manager.watcherType, 'rust');
        assert(manager.watcherEventPoller);
        const file = path.join(root, 'probe.txt');
        await fs.writeFile(file, 'first');
        await waitFor(() => events.some(e => e.file === file && ['add', 'change'].includes(e.event)), 'native add');
        assert(events.find(e => e.file === file).options.stable);
        events.length = 0;
        await fs.writeFile(file, 'second and different');
        await waitFor(() => events.some(e => e.file === file && e.event === 'change'), 'native change');
        events.length = 0;
        await fs.unlink(file);
        await waitFor(() => events.some(e => e.file === file && e.event === 'unlink'), 'native unlink');

        clearInterval(manager.watcherEventPoller);
        manager.watcherEventPoller = null;
        manager.watcher.stopWatch();
        const nativeWatcher = manager.watcher;
        events.length = 0;
        manager.watcher = {
            drainEvents: limit => {
                assert.equal(limit, 256);
                return [9, 8, 9, 10].map(generation => ({
                    event: 'change', path: file, stable: true, generation
                }));
            }
        };
        manager.watcherPathGenerations.clear();
        manager._drainRustWatcherEvents();
        assert.deepEqual(events.map(e => e.options.generation), [9, 10]);

        const present = path.join(root, 'present.txt');
        const missing = path.join(root, 'missing.txt');
        await fs.writeFile(present, 'present');
        manager.metaDb.prepare(
            'INSERT INTO files(library,path,checksum,mtime,size,updated_at) VALUES(?,?,?,?,?,?)'
        ).run('Root', 'missing.txt', 'x', 0, 1, 0);
        events.length = 0;
        manager.watcher = { drainEvents: () => [{ event: 'overflow' }] };
        manager._drainRustWatcherEvents();
        await manager.watcherReconcilePromise;
        assert(events.some(e => e.file === present && e.event === 'change'));
        assert(events.some(e => e.file === missing && e.event === 'unlink'));

        manager.watcher = nativeWatcher;
        manager._handleWatcherEvent = originalHandler;
        const stability = manager._queueStableFile(present);
        await manager.shutdown();
        await stability;
        assert.equal(manager.watcherEventPoller, null);
        assert.equal(manager.metaDb, null);
        originalHandler('add', present);
        manager._queueFile(present);
        assert.equal(manager.batchTimer, null);
        console.log('PASS: native add/change/unlink, bounded drain, stale generations, overflow reconciliation, shutdown');
    } finally {
        if (manager.metaDb) await manager.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});