'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');
const DatabaseCoordinator = require('../modules/knowledgeBase/databaseCoordinator');
const IndexRepository = require('../modules/knowledgeBase/indexRepository');

test('unchanged and unreadable files settle indexed receipts even without a commit plan', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-receipts-'));
    const good = path.join(root, 'same.txt');
    const missing = path.join(root, 'missing.txt');
    await fs.writeFile(good, 'same');
    const stat = await fs.stat(good);
    const notices = [];
    const owner = {
        config: { rootPath: root, maxBatchSize: 10 },
        pendingFiles: new Set([good, missing]), watcherPathGenerations: new Map(),
        fileRetryCount: new Map(), _shuttingDown: true,
        _isSqliteBusyError: () => false, _isSqliteCorruptionError: () => false,
        async probeIngestionFiles() {
            return [{ path: 'same.txt', exists: true, mtime: Math.floor(stat.mtimeMs),
                size: stat.size, completeVectors: true, chunkCount: 1, validVectorCount: 1,
                completeTags: true, tagCount: 0, validTagVectorCount: 0 }];
        },
        databaseCoordinator: {
            notifyIndexedFilePaths(paths, error) { notices.push({ paths, error }); }
        }
    };
    owner._shuttingDown = false;
    try {
        await new IngestionPipeline(owner)._flushBatch();
        assert.equal(owner.pendingFiles.size, 0);
        assert.equal(notices.length, 2);
        assert.equal(notices.find(n => n.paths[0] === good).error, null);
        assert.equal(notices.find(n => n.paths[0] === missing).error.code, 'ENOENT');
    } finally {
        owner._shuttingDown = true;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('partial receipt completion does not disable timeout for remaining paths', async () => {
    const coordinator = new DatabaseCoordinator({ owner: {} });
    const pending = coordinator._waitForPathReceipts(['first', 'second'], 'indexed', { timeoutMs: 1000 });
    coordinator.notifyIndexedFilePaths(['first']);
    await assert.rejects(pending, { code: 'KNOWLEDGE_STORE_RECEIPT_TIMEOUT' });
    assert.equal(coordinator.pathWaiters.size, 0);
});

test('reactivated index is not unregistered while checkpoint is in flight', async () => {
    const repo = new IndexRepository({
        config: { indexIdleTTL: 100, persistFolders: new Set() },
        diaryIndices: new Map([['A', {}]]), lastUsed: new Map([['A', 1]])
    });
    let removed = 0;
    repo.onDiaryIndexRemoved = () => removed++;
    repo.saveToDisk = async () => { await repo.getOrLoad('A'); };
    await repo.evictIdle();
    assert.equal(removed, 0);
    assert.equal(repo.diaryIndices.has('A'), true);
});

test('shutdown checkpoints resident indices even when save timers are empty', async () => {
    const repo = new IndexRepository({
        config: { persistFolders: new Set() }, diaryIndices: new Map([['A', {}]])
    });
    repo.tagIndex = {};
    const saved = [];
    repo.saveToDisk = async name => saved.push(name);
    await repo.flushAndStop();
    assert.deepEqual(saved, ['A', 'global_tags']);
});

test('Memo-unavailable hybrid fallback preserves history, sparse/time sources and permissions', async () => {
    const kb = require('../KnowledgeBaseManager');
    const execute = Object.getPrototypeOf(kb).executeNativeRiverQuery;
    const searches = [];
    const owner = {
        config: { dimension: 2 },
        async _getOrLoadDiaryIndex() {},
        async getFileIdsByDiaries() { return [1, 2, 3]; },
        async prepareUnifiedMemoObservation() { throw new Error('MEMO_ARTIFACT_UNAVAILABLE'); },
        async searchKnn(names, vector, k, ...args) {
            searches.push([...vector]);
            const options = args.at(-1);
            assert.deepEqual(options.allowedFileIds, [1, 2]);
            assert.deepEqual(options.deniedFileIds, [3]);
            return [{ id: vector[0] ? 10 : 20, fileId: 1, score: vector[0] ? 0.1 : 0.9 }];
        },
        async getChunksByFilePaths(paths) {
            assert.deepEqual(paths, ['A/sparse.txt', 'A/time.txt']);
            return [
                { id: 30, fileId: 2, fullPath: 'A/sparse.txt', vector: [1, 0] },
                { id: 40, fileId: 2, fullPath: 'A/time.txt', vector: [1, 0] },
                { id: 50, fileId: 3, fullPath: 'A/time.txt', vector: [1, 0] }
            ];
        },
        async deduplicateResults(items) { return items; }
    };
    const result = await execute.call(owner, { vector: [1, 0] }, {
        diaryNames: ['A'], topK: 4, allowedFileIds: [1, 2], deniedFileIds: [3],
        supplementalQueryVectors: [{ vector: [0, 1], weight: 0.8 }],
        hybridPlan: { fileCandidates: [
            { path: 'A\\sparse.txt', bm25Score: 2, normalizedBM25Score: 1 },
            { path: 'A/time.txt', source: 'time', timeScore: 1 }
        ], timePerDiaryLimit: 1, timeGlobalLimit: 1 }
    });
    assert.deepEqual(searches, [[1, 0], [0, 1]]);
    assert.deepEqual(new Set(result.results.map(row => row.id)), new Set([10, 20, 30, 40]));
    assert.equal(result.diagnostics.degraded, true);
});

test('delete batch sends completion receipts and retains failures for retry', async () => {
    const file = path.resolve('delete-fixture.txt');
    const notices = [];
    const owner = {
        config: { maxDeleteBatchSize: 10 }, pendingDeletes: new Set([file]),
        _shuttingDown: true,
        async _handleDeleteBatch() {},
        databaseCoordinator: { notifyDeletedFilePaths(paths) { notices.push(paths); } }
    };
    await new IngestionPipeline(owner)._flushDeleteBatch();
    assert.equal(owner.pendingDeletes.size, 0);
    assert.deepEqual(notices, [[file]]);
});

for (const stage of ['read', 'prepare']) {
    test(`unstable ${stage} snapshot defers retry and clears unrelated fast paths`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-unstable-'));
        const fast = path.join(root, 'fast.txt');
        const changing = path.join(root, 'changing.txt');
        await fs.writeFile(fast, 'fast');
        await fs.writeFile(changing, 'changing');
        const fastStat = await fs.stat(fast);
        const originalRead = fs.readFile;
        const delays = [];
        const originalTimeout = global.setTimeout;
        const originalImmediate = global.setImmediate;
        let immediateCount = 0;
        const owner = {
            config: { rootPath: root, dimension: 2, modelSig: 'test', maxBatchSize: 10,
                batchWindow: 700, sqliteBusyRetryDelayMs: 1000 },
            pendingFiles: new Set([fast, changing]), watcherPathGenerations: new Map(),
            fileRetryCount: new Map(), diaryIndices: new Map(),
            _isSqliteBusyError: () => false, _isSqliteCorruptionError: () => false,
            async probeIngestionFiles() {
                return [{ path: 'fast.txt', exists: true, mtime: Math.floor(fastStat.mtimeMs),
                    size: fastStat.size, completeVectors: true, chunkCount: 1, validVectorCount: 1,
                    completeTags: true, tagCount: 0, validTagVectorCount: 0 }];
            },
            async prepareIngestionText() {
                if (stage === 'prepare') await fs.writeFile(changing, 'changed before commit');
                return { chunks: [], tags: [] };
            },
            async probeMigrationReuse() { return []; },
            async probeIngestionTags() { return []; }
        };
        try {
            fs.readFile = async (...args) => {
                const content = await originalRead(...args);
                if (stage === 'read' && args[0] === changing) {
                    await fs.writeFile(changing, 'changed during read');
                }
                return content;
            };
            global.setTimeout = (_fn, ms) => { delays.push(ms); return {}; };
            global.setImmediate = () => { immediateCount++; };
            await new IngestionPipeline(owner)._flushBatch();
            assert.deepEqual([...owner.pendingFiles], [changing]);
            assert.equal(immediateCount, 0);
            assert.equal(delays.length, 1);
            assert.ok(delays[0] >= 500);
        } finally {
            owner._shuttingDown = true;
            fs.readFile = originalRead;
            global.setTimeout = originalTimeout;
            global.setImmediate = originalImmediate;
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

test('delete commit schedules baseline only for affected resident diaries and normalizes paths', async () => {
    const root = path.resolve('receipt-root');
    const saved = [];
    const owner = {
        config: { rootPath: root }, diaryIndices: new Map([['Hot', {}]]),
        invalidateDiaryDateIndex() {},
        _scheduleIndexSave(name) { saved.push(name); },
        async commitDeleteBatch(paths) {
            assert.deepEqual(paths, ['Hot/note.txt']);
            return { removedChunkIds: [], diaryIndexDeltas: { Hot: {}, Cold: {} }, indexReady: true };
        }
    };
    await new IngestionPipeline(owner)._handleDeleteBatch([path.join(root, 'Hot', 'note.txt')]);
    assert.deepEqual(saved, ['Hot']);
});