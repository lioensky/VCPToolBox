const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ragDiaryPlugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const { PROCESS_DIARY_NAME } = require('../modules/codexMemoryConstants');

test('RAGDiaryPlugin should append Codex recall audit entries only for Codex diaries', async () => {
    const previousLogPath = ragDiaryPlugin.codexRecallAuditLogPath;
    const tempBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-codex-recall-test-'));
    const auditLogPath = path.join(tempBasePath, 'logs', 'codex-memory-recall.jsonl');

    try {
        ragDiaryPlugin.codexRecallAuditLogPath = auditLogPath;

        const payload = ragDiaryPlugin._buildCodexRecallAuditPayload({
            dbName: PROCESS_DIARY_NAME,
            recallType: 'snippet',
            results: [
                {
                    score: 0.91234,
                    source: 'rag',
                    fullPath: `${PROCESS_DIARY_NAME}/2026-04-13-00_00_01.txt`,
                    text: 'Memory-ID: codex-process-alpha\nfirst chunk',
                    matchedTags: ['checkpoint', 'pipeline'],
                    coreTagsMatched: ['!codex']
                },
                {
                    score: 0.81234,
                    source: 'time',
                    sourceFile: `${PROCESS_DIARY_NAME}/2026-04-12-00_00_01.txt`,
                    text: 'Memory-ID: codex-process-beta\nsecond chunk',
                    matchedTags: ['timeline']
                }
            ],
            content: 'snippet recall content',
            useTime: true,
            useGroup: true,
            useRerank: false,
            useGeodesicRerank: false,
            coreTags: ['codex', 'memory']
        });

        assert.ok(payload, 'Codex diary should build an audit payload');
        assert.equal(payload.target, 'process');
        assert.equal(payload.resultCount, 2);
        assert.equal(payload.topSourceFile, `${PROCESS_DIARY_NAME}/2026-04-13-00_00_01.txt`);
        assert.equal(payload.topMemoryId, 'codex-process-alpha');
        assert.deepEqual(payload.memoryIds, ['codex-process-alpha', 'codex-process-beta']);
        assert.deepEqual(payload.topMatchedTags, ['checkpoint', 'pipeline']);
        assert.deepEqual(payload.matchedTags, ['checkpoint', 'pipeline', 'timeline']);
        assert.deepEqual(payload.coreTags, ['!codex', 'codex', 'memory']);

        await ragDiaryPlugin._recordCodexRecallAudit(payload);

        const ignoredPayload = ragDiaryPlugin._buildCodexRecallAuditPayload({
            dbName: 'Nova',
            recallType: 'snippet',
            results: [{ score: 0.5, source: 'rag', fullPath: 'Nova/2026-04-13.txt' }],
            content: 'should not be logged'
        });
        assert.equal(ignoredPayload, null);

        const raw = await fs.readFile(auditLogPath, 'utf8');
        const entries = raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));

        assert.equal(entries.length, 1);
        assert.equal(entries[0].dbName, PROCESS_DIARY_NAME);
        assert.equal(entries[0].target, 'process');
        assert.equal(entries[0].recallType, 'snippet');
        assert.equal(entries[0].resultCount, 2);
        assert.equal(entries[0].fromCache, false);
        assert.equal(entries[0].topMemoryId, 'codex-process-alpha');
        assert.deepEqual(entries[0].memoryIds, ['codex-process-alpha', 'codex-process-beta']);
        assert.deepEqual(entries[0].matchedTags, ['checkpoint', 'pipeline', 'timeline']);
        assert.deepEqual(entries[0].coreTags, ['!codex', 'codex', 'memory']);
        assert.deepEqual(entries[0].sourceKinds, ['rag', 'time']);
    } finally {
        ragDiaryPlugin.codexRecallAuditLogPath = previousLogPath;
        await fs.rm(tempBasePath, { recursive: true, force: true });
    }
});

test('RAGDiaryPlugin cache key should include Codex adaptive tuning snapshot', () => {
    const baseParams = {
        userContent: '需要回忆上次稳定线治理计划',
        aiContent: '继续推进',
        dbName: PROCESS_DIARY_NAME,
        modifiers: '::TagMemo',
        dynamicK: 3,
        ghostTags: [{ name: 'codex', isCore: true }],
        isFreshTimeConversationStart: false
    };

    const baselineKey = ragDiaryPlugin._generateCacheKey(baseParams);
    const zeroSnapshotKey = ragDiaryPlugin._generateCacheKey({
        ...baseParams,
        adaptiveKDelta: 0,
        adaptiveTagWeightDelta: 0,
        adaptiveTruncationDelta: 0,
        adaptiveThresholdDelta: 0
    });
    const boostedSnapshotKey = ragDiaryPlugin._generateCacheKey({
        ...baseParams,
        adaptiveKDelta: 1,
        adaptiveTagWeightDelta: 0.05,
        adaptiveTruncationDelta: 0.1,
        adaptiveThresholdDelta: -0.03
    });

    assert.equal(zeroSnapshotKey, baselineKey);
    assert.notEqual(boostedSnapshotKey, baselineKey);
});

test('RAGDiaryPlugin cache key should include shotgun tuning snapshot', () => {
    const baseParams = {
        userContent: '继续追踪最近几段上下文',
        aiContent: '需要保留当前主题',
        dbName: PROCESS_DIARY_NAME,
        modifiers: '::TagMemo',
        dynamicK: 4
    };

    const baselineKey = ragDiaryPlugin._generateCacheKey(baseParams);
    const defaultShotgunKey = ragDiaryPlugin._generateCacheKey({
        ...baseParams,
        shotgunDecayFactor: 0.85,
        shotgunHistorySegmentLimit: 3
    });
    const tunedShotgunKey = ragDiaryPlugin._generateCacheKey({
        ...baseParams,
        shotgunDecayFactor: 0.65,
        shotgunHistorySegmentLimit: 0
    });

    assert.equal(defaultShotgunKey, baselineKey);
    assert.notEqual(tunedShotgunKey, baselineKey);
});

test('RAGDiaryPlugin time-aware formatter falls back to dates parsed from text', () => {
    const content = ragDiaryPlugin.formatCombinedTimeAwareResults(
        [
            {
                source: 'time',
                text: '[2026.06.01] - 晨间记录\n今天继续做 R15 intake。'
            },
            {
                source: 'time',
                date: '2026-05-01',
                text: '[2026-05-01] - 旧记录\n旧的显式日期记录。'
            },
            {
                source: 'time',
                text: '没有日期头的散记'
            }
        ],
        [{ start: new Date(Date.UTC(2026, 5, 1)), end: new Date(Date.UTC(2026, 5, 2)) }],
        PROCESS_DIARY_NAME,
        { dbName: PROCESS_DIARY_NAME, modifiers: '::Time', k: 2 }
    );

    assert.match(content, /\* \[2026-06-01\] 今天继续做 R15 intake。/);
    assert.ok(
        content.indexOf('* [2026-06-01] 今天继续做 R15 intake。') <
            content.indexOf('* [2026-05-01] 旧的显式日期记录。')
    );
    assert.match(content, /\* \[未知日期\] 没有日期头的散记/);
    assert.doesNotMatch(content, /\[undefined\]/);
});

test('RAGDiaryPlugin fuzzy embedding lookup reuses near-identical cached text without API', () => {
    const originalIndex = ragDiaryPlugin.embeddingTextIndex;
    const originalMaxSize = ragDiaryPlugin.embeddingTextIndexMaxSize;
    const originalEmbeddingCache = ragDiaryPlugin.cacheManager.caches.get('embedding');

    try {
        ragDiaryPlugin.embeddingTextIndex = new Map();
        ragDiaryPlugin.embeddingTextIndexMaxSize = 10;
        ragDiaryPlugin.cacheManager.createCache('embedding', { maxSize: 10, ttl: 60000 });

        const baseText = [
            '稳定线治理需要把本地 intake 结果先固化，再逐项处理 review feedback。',
            '这里的 fuzzy cache 只允许复用高相似度文本的现有向量，不能触发新的 Embedding API。',
            '命中结果必须来自缓存，并且通过 ContextBridge 暴露给折叠模块读取。'
        ].join('');
        const nearText = `${baseText}。`;
        const vector = [0.1, 0.2, 0.3];
        const cacheKey = ragDiaryPlugin.cacheManager.generateKey({ text: baseText.trim() });

        ragDiaryPlugin.cacheManager.set('embedding', cacheKey, vector);
        ragDiaryPlugin._rememberEmbeddingText(cacheKey, baseText.trim());

        const hit = ragDiaryPlugin._findFuzzyEmbeddingFromCache(nearText, {
            threshold: 0.9,
            minLength: 20,
            maxScan: 10,
            maxLengthDiffRatio: 0.1,
            maxLengthDiffAbs: 10
        });

        assert.ok(hit);
        assert.equal(hit.cacheKey, cacheKey);
        assert.equal(hit.vector, vector);
        assert.ok(hit.similarity >= 0.9);

        const bridge = ragDiaryPlugin.getContextBridge();
        const bridgeHit = bridge.getFuzzyEmbeddingFromCache(nearText, {
            threshold: 0.9,
            minLength: 20,
            maxScan: 10,
            maxLengthDiffRatio: 0.1,
            maxLengthDiffAbs: 10
        });

        assert.ok(bridgeHit);
        assert.equal(bridgeHit.cacheKey, cacheKey);
        assert.equal(bridgeHit.vector, vector);
    } finally {
        ragDiaryPlugin.embeddingTextIndex = originalIndex;
        ragDiaryPlugin.embeddingTextIndexMaxSize = originalMaxSize;
        if (originalEmbeddingCache) {
            ragDiaryPlugin.cacheManager.caches.set('embedding', originalEmbeddingCache);
        } else {
            ragDiaryPlugin.cacheManager.caches.delete('embedding');
        }
    }
});

test('RAGDiaryPlugin cached single embedding does not use fuzzy cache by default', async () => {
    const originalIndex = ragDiaryPlugin.embeddingTextIndex;
    const originalMaxSize = ragDiaryPlugin.embeddingTextIndexMaxSize;
    const originalEmbeddingCache = ragDiaryPlugin.cacheManager.caches.get('embedding');
    const originalGetSingleEmbedding = ragDiaryPlugin.getSingleEmbedding;

    try {
        ragDiaryPlugin.embeddingTextIndex = new Map();
        ragDiaryPlugin.embeddingTextIndexMaxSize = 10;
        ragDiaryPlugin.cacheManager.createCache('embedding', { maxSize: 10, ttl: 60000 });
        const freshVector = [0.7, 0.8, 0.9];
        ragDiaryPlugin.getSingleEmbedding = async () => {
            return freshVector;
        };

        const baseText = [
            '稳定线治理需要把本地 intake 结果先固化，再逐项处理 review feedback。',
            '这里的 fuzzy cache 只允许复用高相似度文本的现有向量，不能触发新的 Embedding API。',
            '默认路径必须重新请求当前文本的精确向量，避免语义组和检索缓存被旧文本污染。'
        ].join('');
        const nearText = `${baseText}。`;
        const vector = [0.4, 0.5, 0.6];
        const baseCacheKey = ragDiaryPlugin.cacheManager.generateKey({ text: baseText.trim() });
        const nearCacheKey = ragDiaryPlugin.cacheManager.generateKey({ text: nearText.trim() });

        ragDiaryPlugin.cacheManager.set('embedding', baseCacheKey, vector);
        ragDiaryPlugin._rememberEmbeddingText(baseCacheKey, baseText.trim());

        const result = await ragDiaryPlugin.getSingleEmbeddingCached(nearText);

        assert.equal(result, freshVector);
        assert.equal(ragDiaryPlugin.cacheManager.get('embedding', nearCacheKey), freshVector);
        assert.equal(ragDiaryPlugin.embeddingTextIndex.get(nearCacheKey), nearText.trim());
    } finally {
        ragDiaryPlugin.getSingleEmbedding = originalGetSingleEmbedding;
        ragDiaryPlugin.embeddingTextIndex = originalIndex;
        ragDiaryPlugin.embeddingTextIndexMaxSize = originalMaxSize;
        if (originalEmbeddingCache) {
            ragDiaryPlugin.cacheManager.caches.set('embedding', originalEmbeddingCache);
        } else {
            ragDiaryPlugin.cacheManager.caches.delete('embedding');
        }
    }
});

test('RAGDiaryPlugin cached single embedding can opt in to read-only fuzzy hit', async () => {
    const originalIndex = ragDiaryPlugin.embeddingTextIndex;
    const originalMaxSize = ragDiaryPlugin.embeddingTextIndexMaxSize;
    const originalEmbeddingCache = ragDiaryPlugin.cacheManager.caches.get('embedding');
    const originalGetSingleEmbedding = ragDiaryPlugin.getSingleEmbedding;

    try {
        ragDiaryPlugin.embeddingTextIndex = new Map();
        ragDiaryPlugin.embeddingTextIndexMaxSize = 10;
        ragDiaryPlugin.cacheManager.createCache('embedding', { maxSize: 10, ttl: 60000 });
        ragDiaryPlugin.getSingleEmbedding = async () => {
            throw new Error('Embedding API should not be called for opt-in fuzzy cache hit');
        };

        const baseText = [
            '稳定线治理需要把本地 intake 结果先固化，再逐项处理 review feedback。',
            '这里的 fuzzy cache 只允许复用高相似度文本的现有向量，不能触发新的 Embedding API。',
            '显式 opt-in 命中可以返回旧文本向量，但不能写成当前文本的精确 cache key。'
        ].join('');
        const nearText = `${baseText}。`;
        const vector = [0.4, 0.5, 0.6];
        const baseCacheKey = ragDiaryPlugin.cacheManager.generateKey({ text: baseText.trim() });
        const nearCacheKey = ragDiaryPlugin.cacheManager.generateKey({ text: nearText.trim() });

        ragDiaryPlugin.cacheManager.set('embedding', baseCacheKey, vector);
        ragDiaryPlugin._rememberEmbeddingText(baseCacheKey, baseText.trim());

        const result = await ragDiaryPlugin.getSingleEmbeddingCached(nearText, {
            allowFuzzyCache: true
        });

        assert.equal(result, vector);
        assert.equal(ragDiaryPlugin.cacheManager.get('embedding', nearCacheKey), null);
        assert.equal(ragDiaryPlugin.embeddingTextIndex.has(nearCacheKey), false);
    } finally {
        ragDiaryPlugin.getSingleEmbedding = originalGetSingleEmbedding;
        ragDiaryPlugin.embeddingTextIndex = originalIndex;
        ragDiaryPlugin.embeddingTextIndexMaxSize = originalMaxSize;
        if (originalEmbeddingCache) {
            ragDiaryPlugin.cacheManager.caches.set('embedding', originalEmbeddingCache);
        } else {
            ragDiaryPlugin.cacheManager.caches.delete('embedding');
        }
    }
});
