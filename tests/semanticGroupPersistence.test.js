'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../Plugin/RAGDiaryPlugin/SemanticGroupManager.js');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-group-stats-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const groupsPath = path.join(dir, 'semantic_groups.json');
    const editPath = path.join(dir, 'semantic_groups.edit.json');
    const timers = new Set();
    const io = { ...fs };
    const mod = { exports: {} };
    vm.runInNewContext(await fs.readFile(sourcePath, 'utf8'), {
        __dirname: dir,
        module: mod,
        require: name => name === 'fs' ? { promises: io } : require(name),
        console: { log() {}, warn() {}, error() {} },
        setTimeout(callback, delay) {
            const timer = { callback, delay, referenced: true, unref() { this.referenced = false; } };
            timers.add(timer);
            return timer;
        },
        clearTimeout: timer => timers.delete(timer)
    }, { filename: sourcePath });

    async function open() {
        const manager = new mod.exports({ getSingleEmbeddingCached: async () => [1, 0] });
        await manager._ready;
        return manager;
    }

    const manager = await open();
    manager.groups = {
        fruit: { words: ['apple', 'pear'], activation_count: 5, last_activated: '2000-01-01T00:00:00.000Z' }
    };
    await manager.saveGroups();
    return {
        manager, groupsPath, editPath, timers, io, open,
        read: async () => JSON.parse(await fs.readFile(groupsPath, 'utf8')),
        async flush() {
            assert.equal(timers.size, 1);
            const [timer] = timers;
            timers.delete(timer);
            await timer.callback();
        }
    };
}

test('activation uses one unrefed 60s window; counts survive restart and edit-file sync', async t => {
    const f = await fixture(t);
    assert.equal(f.manager.detectAndActivateGroups('nothing').size, 0);
    assert.equal(f.timers.size, 0);
    let renames = 0;
    f.io.rename = (...args) => { renames++; return fs.rename(...args); };
    assert.equal(f.manager.detectAndActivateGroups('apple').get('fruit').strength, 0.5);
    const [timer] = f.timers;
    for (let i = 0; i < 19; i++) f.manager.detectAndActivateGroups('apple and pear');
    assert.deepEqual([...f.timers], [timer]);
    assert.equal(timer.delay, 60_000);
    assert.equal(timer.referenced, false);
    assert.equal((await f.read()).groups.fruit.activation_count, 5);
    await f.flush();
    assert.equal(renames, 1);
    assert.equal(f.timers.size, 0);
    const saved = (await f.read()).groups.fruit;
    assert.equal(saved.activation_count, 25);
    assert.notEqual(saved.last_activated, '2000-01-01T00:00:00.000Z');
    assert.equal(saved.last_activated, f.manager.groups.fruit.last_activated);

    await fs.writeFile(f.editPath, JSON.stringify({ groups: { fruit: { words: ['apple', 'plum'], weight: 2 } } }));
    const reopened = await f.open();
    assert.equal(reopened.groups.fruit.activation_count, 25);
    assert.equal(reopened.groups.fruit.last_activated, saved.last_activated);
    assert.equal(reopened.groups.fruit.weight, 2);
    assert.deepEqual([...reopened.groups.fruit.words], ['apple', 'plum']);
});

test('queued saves wait for rename, then capture current data; an intervening activation is not lost', async t => {
    const f = await fixture(t);
    let unblock;
    let entered;
    const gate = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let writes = 0;
    f.io.writeFile = (...args) => { writes++; return fs.writeFile(...args); };
    f.io.rename = async (...args) => {
        if (writes === 1) {
            entered();
            await gate;
        }
        await fs.rename(...args);
    };

    const first = f.manager.saveGroups();
    await started;
    let finished = false;
    const second = f.manager.saveGroups().then(() => { finished = true; });
    try {
        f.manager.config = { edited: true };
        f.manager.detectAndActivateGroups('pear');
        await Promise.resolve();
        assert.equal(writes, 1);
        assert.equal(finished, false);
        assert.equal((await f.read()).groups.fruit.activation_count, 5);
    } finally {
        unblock();
        await Promise.all([first, second]);
    }
    const saved = await f.read();
    assert.deepEqual(saved.config, { edited: true });
    assert.equal(saved.groups.fruit.activation_count, 6);
    await f.flush();
    assert.equal(writes, 2, 'a regular save already persisted the dirty stats');
});

test('a failed explicit save surfaces its I/O error and does not poison queued saves', async t => {
    const f = await fixture(t);
    const failure = new Error('rename failed');
    let failOnce = true;
    f.io.rename = (...args) => {
        if (failOnce) {
            failOnce = false;
            throw failure;
        }
        return fs.rename(...args);
    };
    const first = f.manager.saveGroups();
    const second = f.manager.saveGroups();
    await assert.rejects(first, error => error === failure);
    await second;
    assert.deepEqual(await fs.readdir(path.dirname(f.groupsPath)).then(files => files.filter(file => file.endsWith('.tmp'))), []);
});

test('background I/O failure retries without another activation; shutdown flushes a pending window', async t => {
    const f = await fixture(t);
    f.manager.detectAndActivateGroups('apple');
    f.io.rename = async () => { throw new Error('rename failed'); };
    await f.flush();
    assert.equal((await f.read()).groups.fruit.activation_count, 5);
    f.io.rename = fs.rename;
    await f.flush();
    assert.equal((await f.read()).groups.fruit.activation_count, 6);
    assert.equal(f.timers.size, 0);

    f.manager.detectAndActivateGroups('pear');
    assert.equal(f.timers.size, 1);
    await f.manager.shutdown();
    assert.equal(f.timers.size, 0);
    assert.equal((await f.read()).groups.fruit.activation_count, 7);
});
test('shutdown drains activations during the final write, and hot reload resumes scheduling', async t => {
    const f = await fixture(t);
    f.manager.detectAndActivateGroups('apple');
    let renames = 0;
    f.io.rename = (...args) => {
        if (++renames === 1) f.manager.detectAndActivateGroups('pear');
        return fs.rename(...args);
    };

    await f.manager.shutdown();
    assert.equal(renames, 2);
    assert.equal(f.timers.size, 0);
    assert.equal((await f.read()).groups.fruit.activation_count, 7);

    f.manager.resumeStatsFlush();
    f.manager.detectAndActivateGroups('apple');
    await f.flush();
    assert.equal((await f.read()).groups.fruit.activation_count, 8);
});