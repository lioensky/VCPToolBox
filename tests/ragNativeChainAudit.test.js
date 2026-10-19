'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const kbSingleton = require('../KnowledgeBaseManager');
const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

test('audit real Rust store through KBM and RAG message injection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-rag-chain-audit-'));
    const diaryRoot = path.join(root, 'notes');
    fs.mkdirSync(diaryRoot);
    const kb = new kbSingleton.constructor({
        rootPath: diaryRoot, storePath: path.join(root, 'store'),
        dimension: 4, modelSig: 'chain-audit', fullScanOnStartup: false
    });
    // Disable OS watchers and automatic jobs only; storage/query implementations stay real.
    kb._startWatcher = () => {};
    kb._startRagParamsWatcher = () => {};
    kb._startIdleSweep = () => {};
    kb._startEventLoopWatchdog = () => {};
    const rag = new ragSingleton.constructor();
    const query = new Float32Array([1, 0, 0, 0]);
    const broadcasts = [];
    try {
        await kb.initialize();
        clearTimeout(kb.tagMemoEngine._postStartupDerivedRefreshTimer);
        const contents = [
            '[2026-10-18] - Audit\nalpha memory about database migration\nTag: alpha, beta',
            '[2026-10-17] - Audit\nbeta memory about native queries\nTag: beta, gamma',
            '[2026-10-16] - Audit\noutside permission sentinel\nTag: gamma'
        ];
        const names = ['A', 'B', 'Outside'];
        const files = contents.map((content, i) => {
            const relative = `${names[i]}/note.md`;
            fs.mkdirSync(path.join(diaryRoot, names[i]));
            fs.writeFileSync(path.join(diaryRoot, relative), content);
            return {
                path: relative, diaryName: names[i], checksum: `audit-${i}`,
                mtime: 1, size: Buffer.byteLength(content), expectedVersion: 0,
                chunkStart: i, chunkCount: 1, tagStart: i * 2,
                tagCount: i === 2 ? 1 : 2
            };
        });
        await kb.commitIngestionBatch({
            operationId: 'chain-seed', batchId: 'chain-seed', dimension: 4,
            files, chunks: contents.map((content, i) => ({
                content, chunkIndex: 0, vectorSlot: i
            })),
            tags: ['alpha', 'beta', 'beta', 'gamma', 'gamma'].map((name, i) => ({
                name, position: i % 2 + 1, vectorSlot: i
            }))
        }, new Float32Array([1,0,0,0, 0.8,0.6,0,0, 0.6,0.5,0.5,0]),
        new Float32Array([1,0,0,0, 0.8,0.6,0,0, 0.8,0.6,0,0, 0,1,0,0, 0,1,0,0]));
        assert.equal(await kb.tagMemoEngine.doMatrixRebuild({ reason: 'audit' }), true);
        const native = await kb.executeNativeRiverQuery(
            { text: 'alpha migration', vector: query },
            { diaryNames: ['A', 'B'], topK: 2, fallbackToLegacy: false }
        );
        assert.equal(native.diagnostics.nativeTopologyV3.jointUsed, true);
        assert(native.artifactSig);
        assert(native.results.length > 0);
        assert(native.results.every(row => ['A', 'B'].includes(row.diaryName)));
        assert(native.results.every(row => row.text && row.fullPath));
        const hybrid = await kb.executeNativeRiverQuery(
            { text: 'alpha migration', vector: query },
            {
                diaryNames: ['A', 'B'], topK: 2, fallbackToLegacy: false,
                supplementalQueryVectors: [{ vector: [0,1,0,0], weight: 0.8 }],
                hybridPlan: { fileCandidates: [
                    { path: 'A/note.md', timeScore: 1, source: 'time' },
                    { path: 'B/note.md', bm25Score: 2, normalizedBM25Score: 1, source: 'bm25_body' }
                ], bm25Mode: 'body', bm25Weight: 0.6 }
            }
        );
        assert.equal(hybrid.diagnostics.nativeTopologyV3.hybridPlanUsed, true);
        assert(hybrid.results.some(row => row.source === 'time'));
        assert.equal((await kb.getDiaryDateIndex('A')).length, 1);
        assert.equal((await kb.getChunksByFilePaths(['A/note.md']))[0].vector.length, 4);
        assert.equal((await kb.getTagVectorByName('alpha')).length, 4);

        // 真实原生多索引查询：共享 Sense，但候选、权限及排序独立。
        const pipelineOriginal = kb.tagIndex.runMemoPipeline.bind(kb.tagIndex);
        let pipelineCalls = 0;
        kb.tagIndex.runMemoPipeline = (...args) => {
            pipelineCalls++;
            return pipelineOriginal(...args);
        };
        const memoryBefore = JSON.parse(kb.tagIndex.memoObservationMemoryStats()).entries;
        try {
            await kb.withMemoObservationScope(async () => {
                const results = await Promise.all(['A', 'B'].map(name =>
                    kb.executeNativeRiverQuery(
                        { text: 'shared native audit', vector: query },
                        { diaryNames: [name], topK: 1, fallbackToLegacy: false }
                    )
                ));
                assert.equal(pipelineCalls, 1, 'two scopes must execute one native Sense');
                results.forEach((result, index) => {
                    assert.equal(result.results.length, 1);
                    assert(result.results.every(row => row.diaryName === ['A', 'B'][index]));
                });
                assert.equal(JSON.parse(kb.tagIndex.memoObservationMemoryStats()).entries,
                    memoryBefore + 1, 'one shared native observation remains alive');
            });
            assert.equal(JSON.parse(kb.tagIndex.memoObservationMemoryStats()).entries,
                memoryBefore, 'request end releases the shared native observation');
        } finally {
            kb.tagIndex.runMemoPipeline = pipelineOriginal;
        }

        rag.vectorDBManager = kb;
        rag.queryCacheEnabled = false;
        rag.ragParams = {};
        rag.rerankConfig = { multiplier: 2 };
        rag.pushVcpInfo = data => broadcasts.push(data);
        rag.getSingleEmbeddingCached = async () => query;
        rag.riverThinkingConfig = {
            enabled: true, candidateK: 16, maxTransitionRecords: 8000, minClosure: 0
        };
        rag.metaThinkingManager.metaThinkingChains = {
            chains: { default: { clusters: ['A', 'B'], kSequence: [1, 1] } }
        };
        const messages = [
            { role: 'system', content: '[[A|B日记本::RiverMemo]]\n[[VCP元思考]]' },
            { role: 'user', content: 'alpha migration' }
        ];
        const processed = await rag.processMessages(messages, {});
        assert.doesNotMatch(processed[0].content, /处理失败|TOOL_REQUEST|__VCP_META_PENDING_|\[\[A\|B日记本/);
        assert.match(processed[0].content, /alpha memory|beta memory/);
        const detail = broadcasts.find(item => item.type === 'RAG_RETRIEVAL_DETAILS');
        assert.equal(detail.riverMemo.nativeJointQuery, true);
        assert(detail.riverMemo.artifactSig);
        assert(broadcasts.some(item => item.type === 'META_THINKING_CHAIN'));
        console.log('[CHAIN AUDIT] native/hybrid/injection passed; meta engine:',
            broadcasts.find(item => item.type === 'META_THINKING_CHAIN').engine);

        const associates = await rag._applyAssociativeDiscovery(
            native.results, ['A', 'B', 'Outside'], 3, null, {}
        );
        assert(Array.isArray(associates));
        assert(associates.some(row => row.fullPath === 'Outside/note.md'));
        console.log('[CHAIN AUDIT] real River Associate shared candidate passed');

        const timeText = await rag._processRAGPlaceholder({
            dbName: ['A', 'B'], modifiers: '::RiverMemo::Time0.5::Associate',
            queryVector: query, userContent: 'alpha migration',
            combinedQueryForDisplay: 'alpha migration', dynamicK: 2,
            timeRanges: [{ start: new Date('2026-10-17T00:00:00+08:00'),
                end: new Date('2026-10-18T23:59:59+08:00') }]
        });
        assert.equal(typeof timeText, 'string');
        assert.match(timeText, /memory/);
        console.log('[CHAIN AUDIT] plugin Time/Associate suffix pipeline passed');

        // Reproduce cache mode collision without changing production behavior.
        rag.queryCacheEnabled = true;
        rag.cacheManager.createCache('query');
        const options = {
            dbName: 'A', modifiers: '::RiverMemo', queryVector: query,
            userContent: 'cache audit', aiContent: '', combinedQueryForDisplay: 'cache audit',
            dynamicK: 1, timeRanges: []
        };
        await rag._processRAGPlaceholder(options);
        const raw = await rag._processRAGPlaceholder({ ...options, returnRawResults: true });
        assert.equal(typeof raw, 'string', 'audit reproduction: raw request receives cached formatted text');
        console.log('[CHAIN AUDIT] CONFIRMED raw-result cache type collision');

        const defaultOptions = { ...options, modifiers: '', userContent: 'default sense cache' };
        const firstRequest = rag._createRequestCache();
        firstRequest.riverThinking = { config: rag.riverThinkingConfig, observations: [], deferred: [] };
        await rag._processRAGPlaceholder({ ...defaultOptions, requestCache: firstRequest });
        assert.equal(firstRequest.riverThinking.observations.length, 1);
        const nextRequest = rag._createRequestCache();
        nextRequest.riverThinking = { config: rag.riverThinkingConfig, observations: [], deferred: [] };
        await rag._processRAGPlaceholder({ ...defaultOptions, requestCache: nextRequest });
        assert.equal(nextRequest.riverThinking.observations.length, 0);
        console.log('[CHAIN AUDIT] CONFIRMED default River cache skips request Sense');

        // Reproduce silent engine misreport after actual native artifact invalidation.
        kb.tagMemoV10Engine.invalidateArtifact('audit-degradation');
        const degraded = await kb.executeNativeRiverQuery(
            { text: 'degraded', vector: query }, { diaryNames: ['A'], topK: 1 }
        );
        assert.equal(degraded.diagnostics.retrievalEngine, 'knn');
        const bridge = await rag.getContextBridge().retrieveDiary({
            diaryNames: ['A'], queryVector: query, fallback: 'none'
        });
        assert.equal(bridge.results[0].retrievalEngine, 'knn');
        assert.equal(bridge.meta.riverMemoUsed, true);
        console.log('[CHAIN AUDIT] CONFIRMED bridge reports RiverMemo for degraded KNN');
    } finally {
        rag.shutdown();
        await kb.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
});