'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const embeddingPath = require.resolve('../EmbeddingUtils');

function makePipelineOwner(root, files, overrides = {}) {
    return {
        config: {
            rootPath: root,
            dimension: 2,
            modelSig: 'test',
            maxBatchSize: 50,
            sqliteBusyRetryDelayMs: 1000,
            vectorRepairBaseDelayMs: 5000,
            vectorRepairMaxDelayMs: 900000,
            vectorRepairBackoffFactor: 3,
            vectorRepairJitterRatio: 0,
            ...(overrides.config || {})
        },
        pendingFiles: new Set(files),
        pendingDeletes: new Set(),
        watcherPathGenerations: new Map(),
        fileRetryCount: new Map(),
        diaryIndices: new Map(),
        probeIngestionFiles: async () => [],
        prepareIngestionText: async text => ({ chunks: [text], tags: [] }),
        probeMigrationReuse: async () => [],
        probeIngestionTags: async () => [],
        _prepareTextForEmbedding: text => text,
        _isSqliteBusyError: () => false,
        _isSqliteCorruptionError: () => false,
        invalidateDiaryDateIndex() {},
        async commitIngestionBatch() {
            return { factsCommitted: true, indexReady: true, newTagIds: [], affectedDiaries: [] };
        },
        ...overrides
    };
}

test('computeVectorRepairDelayMs 按 5s→15s→45s… 指数退避并在 15 分钟封顶', () => {
    const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');
    const fn = IngestionPipeline.computeVectorRepairDelayMs;

    assert.equal(fn(0, { vectorRepairJitterRatio: 0 }, () => 0), 5000);
    assert.equal(fn(1, { vectorRepairJitterRatio: 0 }, () => 0), 5000);
    assert.equal(fn(2, { vectorRepairJitterRatio: 0 }, () => 0), 15000);
    assert.equal(fn(3, { vectorRepairJitterRatio: 0 }, () => 0), 45000);
    assert.equal(fn(4, { vectorRepairJitterRatio: 0 }, () => 0), 135000);
    assert.equal(fn(5, { vectorRepairJitterRatio: 0 }, () => 0), 405000);
    assert.equal(fn(6, { vectorRepairJitterRatio: 0 }, () => 0), 900000);
    assert.equal(fn(20, { vectorRepairJitterRatio: 0 }, () => 0), 900000);

    // 含抖动时不超过上限
    assert.equal(fn(2, { vectorRepairJitterRatio: 0.1 }, () => 1), 16500);
    assert.equal(fn(6, { vectorRepairJitterRatio: 0.1 }, () => 1), 900000);
});

test('缺向量修复按指数退避持续重试不丢文件，且 chunk 全失败时跳过同轮 tag 向量请求', async () => {
    let embedCalls = [];
    let embedImpl = async texts => texts.map(() => null);
    require.cache[embeddingPath] = {
        id: embeddingPath,
        filename: embeddingPath,
        loaded: true,
        exports: {
            getEmbeddingsBatch: async (texts, cfg) => {
                embedCalls.push(texts.slice());
                return embedImpl(texts, cfg);
            }
        }
    };
    delete require.cache[require.resolve('../modules/knowledgeBase/ingestionPipeline')];
    const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-repair-backoff-'));
    const fileA = path.join(root, 'a.txt');
    await fs.writeFile(fileA, 'alpha content');

    const scheduledDelays = [];
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    try {
        global.setTimeout = (_fn, ms) => {
            scheduledDelays.push(ms);
            return { _mockTimer: true };
        };
        global.clearTimeout = () => {};

        const owner = makePipelineOwner(root, [fileA], {
            prepareIngestionText: async text => ({ chunks: [text], tags: ['tag1', 'tag2'] })
        });
        const pipeline = new IngestionPipeline(owner);

        // 第 1 次全失败：5s，且因 chunk 全失败，不发 tag 请求
        await pipeline._flushBatch();
        assert.equal(embedCalls.length, 1);
        assert.deepEqual(embedCalls[0], ['alpha content']);
        assert.equal(owner.pendingFiles.has(fileA), true);
        assert.equal(owner._vectorRepairStreak, 1);
        assert.deepEqual(scheduledDelays, [5000]);

        // 模拟冷却时间未到时再次被 watcher 直接触发 _flushBatch：应跳过 API 调用，只等待剩余冷却
        embedCalls = [];
        await pipeline._flushBatch();
        assert.equal(embedCalls.length, 0);

        // 模拟第 2 次冷却期满后仍全失败：15s
        owner._vectorRepairCooldownUntil = Date.now() - 1;
        owner.batchTimer = null;
        await pipeline._flushBatch();
        assert.equal(embedCalls.length, 1);
        assert.equal(owner._vectorRepairStreak, 2);
        assert.equal(scheduledDelays.at(-1), 15000);

        // 模拟第 3 次冷却期满后仍全失败：45s（且始终不放弃 fileA）
        owner._vectorRepairCooldownUntil = Date.now() - 1;
        owner.batchTimer = null;
        await pipeline._flushBatch();
        assert.equal(owner._vectorRepairStreak, 3);
        assert.equal(scheduledDelays.at(-1), 45000);
        assert.equal(owner.pendingFiles.has(fileA), true);

        // 模拟部分进度（chunk 成功、tag 仍失败）：重置 streak 为 0，下轮退避回到基础 5s
        embedCalls = [];
        let callIdx = 0;
        embedImpl = async texts => {
            callIdx += 1;
            if (callIdx === 1) return texts.map(() => [1, 0]);
            return texts.map(() => null);
        };
        owner._vectorRepairCooldownUntil = Date.now() - 1;
        owner.batchTimer = null;
        await pipeline._flushBatch();
        assert.equal(embedCalls.length, 2);
        assert.equal(owner._vectorRepairStreak, 0);
        assert.equal(scheduledDelays.at(-1), 5000);
        assert.equal(owner.pendingFiles.has(fileA), true);

        // 第 5 次全部成功：移出队列并清空修复状态
        embedImpl = async texts => texts.map(() => [1, 0]);
        owner._vectorRepairCooldownUntil = Date.now() - 1;
        owner.batchTimer = null;
        await pipeline._flushBatch();
        assert.equal(owner.pendingFiles.size, 0);
        assert.equal(owner._vectorRepairFiles.size, 0);
        assert.equal(owner._vectorRepairStreak, 0);
        assert.equal(owner._vectorRepairCooldownUntil, 0);
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        delete require.cache[embeddingPath];
        delete require.cache[require.resolve('../modules/knowledgeBase/ingestionPipeline')];
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('修复冷却期间新增的全新文件仍会立即处理，不捎带冷却中的旧修复文件', async () => {
    const processedBatches = [];
    require.cache[embeddingPath] = {
        id: embeddingPath,
        filename: embeddingPath,
        loaded: true,
        exports: {
            getEmbeddingsBatch: async texts => {
                processedBatches.push(texts.slice());
                return texts.map(() => [1, 0]);
            }
        }
    };
    delete require.cache[require.resolve('../modules/knowledgeBase/ingestionPipeline')];
    const IngestionPipeline = require('../modules/knowledgeBase/ingestionPipeline');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kbm-repair-fresh-'));
    const oldRepairFile = path.join(root, 'old.txt');
    const freshFile = path.join(root, 'fresh.txt');
    await fs.writeFile(oldRepairFile, 'old-content');
    await fs.writeFile(freshFile, 'fresh-content');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalSetImmediate = global.setImmediate;
    try {
        global.setTimeout = () => ({ _mockTimer: true });
        global.clearTimeout = () => {};
        global.setImmediate = () => {};

        const owner = makePipelineOwner(root, [oldRepairFile, freshFile], {
            _vectorRepairFiles: new Set([oldRepairFile]),
            _vectorRepairStreak: 3,
            _vectorRepairCooldownUntil: Date.now() + 60000
        });
        await new IngestionPipeline(owner)._flushBatch();

        assert.deepEqual(processedBatches, [['fresh-content']]);
        assert.equal(owner.pendingFiles.has(freshFile), false);
        assert.equal(owner.pendingFiles.has(oldRepairFile), true);
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        global.setImmediate = originalSetImmediate;
        delete require.cache[embeddingPath];
        delete require.cache[require.resolve('../modules/knowledgeBase/ingestionPipeline')];
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('getEmbeddingsBatch 在无备援模型遇到 429 时不空等备援切换并熔断剩余未发批次', async () => {
    delete require.cache[embeddingPath];
    const { getEmbeddingsBatch } = require('../EmbeddingUtils');

    const savedBackups = {
        EmbeddingModelBackups: process.env.EmbeddingModelBackups,
        EmbeddingModelBackup: process.env.EmbeddingModelBackup,
        EmbeddingModelBackup1: process.env.EmbeddingModelBackup1
    };
    delete process.env.EmbeddingModelBackups;
    delete process.env.EmbeddingModelBackup;
    delete process.env.EmbeddingModelBackup1;

    try {
        // 100 条输入 -> 按 MAX_BATCH_ITEMS=32 拆为 4 个批；concurrency=1 时批 1 遇 429 应熔断后续 3 个批
        const inputs = Array.from({ length: 100 }, (_, i) => `item-${i}`);
        let fetchCount = 0;
        const start = Date.now();
        const result = await getEmbeddingsBatch(inputs, {
            apiUrl: 'http://127.0.0.1:65530',
            apiKey: 'test-key',
            model: 'primary-embed',
            concurrency: 1,
            fetchImpl: async () => {
                fetchCount += 1;
                return {
                    ok: false,
                    status: 429,
                    text: async () => JSON.stringify({ error: { message: 'rate limit' } })
                };
            }
        });
        const elapsedMs = Date.now() - start;

        assert.equal(fetchCount, 1, '无备援模型时遇 429 应立即熔断后续未启动批次');
        assert.ok(elapsedMs < 2000, `不应空等 5s 备援切换，实际耗时 ${elapsedMs}ms`);
        assert.equal(result.length, 100);
        assert.equal(result.every(v => v === null), true);
    } finally {
        for (const [k, v] of Object.entries(savedBackups)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});
