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
