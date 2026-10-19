'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const KnowledgeBaseFileWatcher = require('../modules/knowledgeBase/fileWatcher');

function fixture() {
    const requests = [];
    const snapshots = [];
    const runtime = {
        listIndexedFilePaths() {
            return new Promise(resolve => snapshots.push(resolve));
        },
        reconcileWatchWithPaths(paths) {
            requests.push(paths);
        },
        stopWatch() {}
    };
    const owner = {
        dbPath: 'unused-test.sqlite',
        nativeKnowledgeRuntime: runtime,
        watcherPathGenerations: new Map(),
        pendingFiles: new Set(),
        pendingDeletes: new Set(),
        staleWatcherEventsDropped: 0,
        _queueDelete(value) { this.pendingDeletes.add(value); }
    };
    const watcher = new KnowledgeBaseFileWatcher({ owner });
    watcher.watcher = runtime;
    watcher.watcherType = 'runtime-owned-rust';
    return { owner, watcher, snapshots, requests };
}

test('stopped watcher rejects an in-flight indexed-path snapshot', async () => {
    const { watcher, snapshots, requests } = fixture();
    const pending = watcher._reconcileAfterOverflow();
    await watcher.stop();
    snapshots[0]('["diary/missing.txt"]');
    await pending;
    assert.deepEqual(requests, []);
});

test('overflow during snapshot preparation schedules another snapshot', async () => {
    const { watcher, snapshots, requests } = fixture();
    const pending = watcher._reconcileAfterOverflow();
    await watcher._reconcileAfterOverflow();
    snapshots[0]('["diary/first.txt"]');
    await pending;
    assert.equal(snapshots.length, 2);
    snapshots[1]('["diary/second.txt"]');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [
        ['diary/first.txt'],
        ['diary/second.txt']
    ]);
    await watcher.stop();
});

test('unstable unlink cannot queue deletion', () => {
    const { watcher, owner } = fixture();
    watcher._handleRustEvent(JSON.stringify({
        event: 'unlink',
        path: 'diary/missing.txt',
        generation: 1,
        stable: false
    }));
    assert.equal(owner.pendingDeletes.size, 0);
    watcher._handleRustEvent(JSON.stringify({
        event: 'unlink',
        path: 'diary/missing.txt',
        generation: 2,
        stable: true
    }));
    assert.equal(owner.pendingDeletes.size, 1);
});

for (const enabled of [false, true]) {
    test(`startup scan=${enabled} controls startup reconciliation without disabling overflow recovery`, async () => {
        const { watcher, owner, snapshots, requests } = fixture();
        owner.config = { rootPath: 'fixture', fullScanOnStartup: enabled };
        owner.nativeKnowledgeRuntime.startWatch = options => {
            assert.equal(options.initialScan, false,
                'startup reconciliation must be the only full scan');
            assert.deepEqual(options.ignoreFolders, []);
        };
        owner.nativeKnowledgeRuntime.drainWatchEvents = () => [];
        watcher.watcher = null;
        watcher.start();
        try {
            assert.equal(snapshots.length, enabled ? 1 : 0);
            if (enabled) {
                snapshots[0]('[]');
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(requests, [[]]);
            } else {
                watcher._handleRustEvent({ event: 'overflow' });
                assert.equal(snapshots.length, 1);
                snapshots[0]('["diary/known.txt"]');
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(requests, [['diary/known.txt']]);
            }
        } finally {
            await watcher.stop();
        }
    });
}