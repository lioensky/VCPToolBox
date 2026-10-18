'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const embeddingPath = require.resolve('../EmbeddingUtils');
let embed;
require.cache[embeddingPath] = {
    id: embeddingPath, filename: embeddingPath, loaded: true,
    exports: { getEmbeddingsBatch: (...args) => embed(...args) }
};
const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');

for (const mutation of ['content', 'generation', 'none']) {
    test(`precommit diagnostics distinguish ${mutation} changes`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-snapshot-'));
        const file = path.join(root, 'note.txt');
        await fs.writeFile(file, 'body');
        const warnings = [];
        const delays = [];
        let commits = 0;
        const owner = {
            config: {
                rootPath: root, dimension: 2, modelSig: 'test',
                maxBatchSize: 10, sqliteBusyRetryDelayMs: 1000
            },
            pendingFiles: new Set([file]),
            watcherPathGenerations: new Map([[file, 1]]),
            fileRetryCount: new Map(),
            diaryIndices: new Map(),
            probeIngestionFiles: async () => [],
            prepareIngestionText: async text => ({ chunks: [text], tags: [] }),
            probeMigrationReuse: async () => [],
            probeIngestionTags: async () => [],
            _isSqliteBusyError: () => false,
            _isSqliteCorruptionError: () => false,
            invalidateDiaryDateIndex() {},
            async commitIngestionBatch() {
                commits++;
                return { indexReady: true };
            }
        };
        embed = async texts => {
            if (mutation === 'content') await fs.writeFile(file, 'changed body');
            if (mutation === 'generation') owner.watcherPathGenerations.set(file, 2);
            return texts.map(() => [1, 0]);
        };
        const originalWarn = console.warn;
        const originalTimeout = global.setTimeout;
        try {
            console.warn = (...args) => warnings.push(args.join(' '));
            global.setTimeout = (_fn, ms) => { delays.push(ms); return {}; };
            await new IngestionPipeline(owner)._flushBatch();
            if (mutation === 'none') {
                assert.equal(commits, 1);
                assert.equal(owner.pendingFiles.size, 0);
                assert.deepEqual(warnings, []);
                assert.deepEqual(delays, []);
            } else {
                assert.equal(commits, 0);
                assert.equal(owner.pendingFiles.has(file), true);
                assert.equal(owner.fileRetryCount.size, 0);
                assert.deepEqual(delays, [1000]);
                const diagnostic = warnings.find(line => line.includes('Pre-commit snapshot changed:'));
                assert.ok(diagnostic);
                const snapshot = JSON.parse(diagnostic.slice(diagnostic.indexOf('{')));
                assert.equal(snapshot.path, 'note.txt');
                if (mutation === 'generation') {
                    assert.deepEqual(snapshot.generation, { expected: 1, actual: 2 });
                    assert.equal(snapshot.size.expected, snapshot.size.actual);
                    assert.equal(snapshot.mtimeMs.expected, snapshot.mtimeMs.actual);
                } else {
                    assert.notEqual(snapshot.size.expected, snapshot.size.actual);
                }
                assert.ok(warnings.some(line => line.includes('Batch deferred without commit:')));
            }
        } finally {
            owner._shuttingDown = true;
            console.warn = originalWarn;
            global.setTimeout = originalTimeout;
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}