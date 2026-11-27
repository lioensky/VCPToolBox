'use strict';
// Bridge-level orchestration test: the real RAGDiaryPlugin singleton drives
// recallMemory with the heavyweight retrieval machinery stubbed at the seam
// (_processRAGPlaceholder, embedding, ghost anchors). The pipeline itself is
// covered by the upstream retrieval suites; this file pins the orchestration
// contract that /v1/memory/search depends on.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

function stubPlugin(t) {
    const saved = {
        getSingleEmbeddingCached: plugin.getSingleEmbeddingCached,
        _processRAGPlaceholder: plugin._processRAGPlaceholder,
        _resolveGhostAnchors: plugin._resolveGhostAnchors,
        riverThinkingConfig: plugin.riverThinkingConfig,
        ragParams: plugin.ragParams,
        metaThinkingManager: plugin.metaThinkingManager,
        vectorDBManager: plugin.vectorDBManager,
        updateContext: plugin.contextVectorManager?.updateContext,
        segmentContext: plugin.contextVectorManager?.segmentContext
    };
    const calls = { embed: [], pipeline: [], ghost: [], meta: [], release: [] };
    plugin.getSingleEmbeddingCached = async (text, options = {}) => {
        calls.embed.push([text, options.contextRole || null]);
        if (options.contextRole === 'assistant') return [0, 1];
        return [1, 0];
    };
    plugin._processRAGPlaceholder = async options => {
        calls.pipeline.push(options);
        return [
            { diaryName: 'notes', text: 'main hit', fullPath: '/private/root/notes/a.md', score: 0.9, vector: [1], artifactSig: 'internal' },
            { diaryName: 'notes', text: 'co-occurring', sourceFile: 'folder/b.md', score: 0.5, source: 'associate', _associateCoCount: 3, chunkId: 7 }
        ];
    };
    plugin._resolveGhostAnchors = async (tags, isCore) => {
        calls.ghost.push([tags, isCore]);
        return tags.map(name => ({ name, vector: [1], isCore }));
    };
    plugin.ragParams = { RAGDiaryPlugin: { mainSearchWeights: [0.7, 0.3] } };
    plugin.riverThinkingConfig = { enabled: true, maxTransitionRecords: 100 };
    plugin.metaThinkingManager = {
        calls: [],
        async processMetaThinkingV3(pool, vector, user, ai, display, group, options) {
            calls.meta.push({ pool, vector, user, ai, group, observation: await options.getObservation() });
            return '$$fixture-formula$$';
        },
        _resolveV3StarPoolDiaries(scope) {
            return scope ? scope.split('|').map(s => s.trim()).filter(Boolean) : ['default-pool'];
        }
    };
    plugin.vectorDBManager = {
        releaseMemoObservation(prepared) { calls.release.push(prepared); }
    };
    if (plugin.contextVectorManager) {
        plugin.contextVectorManager.updateContext = async () => ({ snapshotVectorByHash: new Map(), historyAssistantVectors: [[0, 1]] });
        plugin.contextVectorManager.segmentContext = () => [{ vector: [1, 1], texts: ['earlier'], role: 'user' }];
    }
    // riverThinking observations need a hook into the pipeline stub: push them when requested
    const originalPipeline = plugin._processRAGPlaceholder;
    plugin._processRAGPlaceholder = async options => {
        if (options.requestCache?.riverThinking) {
            const prepared = { fake: 'observation' };
            options.requestCache.riverThinking.observations.push({ scope: 'fixture', useGroup: false, prepared });
            options.requestCache.ownedMemoObservations?.add(prepared);
        }
        return originalPipeline(options);
    };
    t.after(() => {
        plugin.getSingleEmbeddingCached = saved.getSingleEmbeddingCached;
        plugin._processRAGPlaceholder = saved._processRAGPlaceholder;
        plugin._resolveGhostAnchors = saved._resolveGhostAnchors;
        plugin.riverThinkingConfig = saved.riverThinkingConfig;
        plugin.ragParams = saved.ragParams;
        plugin.metaThinkingManager = saved.metaThinkingManager;
        plugin.vectorDBManager = saved.vectorDBManager;
        if (plugin.contextVectorManager && saved.updateContext) plugin.contextVectorManager.updateContext = saved.updateContext;
        if (plugin.contextVectorManager && saved.segmentContext) plugin.contextVectorManager.segmentContext = saved.segmentContext;
    });
    return calls;
}

test('single query drives the native pipeline and shapes safe structured output', async t => {
    const calls = stubPlugin(t);
    const bridge = plugin.getContextBridge();
    assert.equal(bridge.version, '1.4');
    const result = await bridge.recallMemory({ query: '  what did we decide?  ', diaries: ['notes', 'notes'], k: 5 });
    assert.equal(calls.pipeline.length, 1);
    const options = calls.pipeline[0];
    assert.deepEqual(options.dbName, ['notes']);
    assert.equal(options.modifiers, '::RiverMemo');
    assert.equal(options.dynamicK, 5);
    assert.equal(options.userContent, 'what did we decide?');
    assert.equal(options.returnRawResults, true);
    // shaping: rank, basename only, no internal leakage
    assert.equal(result.direct.length, 1);
    assert.deepEqual(Object.keys(result.direct[0]).sort(), ['diary', 'file', 'rank', 'score', 'scoreSource', 'text']);
    assert.equal(result.direct[0].file, 'a.md');
    assert.doesNotMatch(JSON.stringify(result), /private|artifactSig|vector|fullPath/);
    assert.equal(result.associated, undefined);
    assert.equal(result.metaFormula, undefined);
});

test('conversation projection embeds both roles and weights the query vector', async t => {
    const calls = stubPlugin(t);
    const bridge = plugin.getContextBridge();
    const conversation = [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'current question' }
    ];
    await bridge.recallMemory({ query: 'current question', diaries: ['notes'], k: 5, conversation });
    const roles = calls.embed.map(([, role]) => role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('assistant'));
    const options = calls.pipeline[0];
    // 0.7*[1,0] + 0.3*[0,1] = [0.7, 0.3]
    assert.ok(Math.abs(options.queryVector[0] - 0.7) < 1e-9, JSON.stringify(options.queryVector));
    assert.ok(Math.abs(options.queryVector[1] - 0.3) < 1e-9, JSON.stringify(options.queryVector));
    assert.equal(options.userContent, 'current question');
    assert.equal(options.aiContent, 'earlier answer');
    assert.ok(Array.isArray(options.historySegments));
    assert.equal(options.historySegments.length, 1); // stubbed segment
});

test('associate results split with seedCount; coreTags become strong ghost anchors', async t => {
    const calls = stubPlugin(t);
    const bridge = plugin.getContextBridge();
    const result = await bridge.recallMemory({
        query: 'q', diaries: ['notes'], k: 5, associate: true, coreTags: ['因果链'], rankModifiers: '::Jev'
    });
    assert.deepEqual(calls.ghost, [[['因果链'], true]]);
    assert.equal(calls.pipeline[0].modifiers, '::RiverMemo::Jev::Associate');
    assert.equal(calls.pipeline[0].ghostTags.length, 1);
    assert.equal(calls.pipeline[0].ghostTags[0].isCore, true);
    assert.equal(result.associated.length, 1);
    assert.equal(result.associated[0].seedCount, 3);
    assert.equal(result.associated[0].chunkId, 7);
    assert.equal(result.direct.length, 1);
});

test('metaThinking shares the retrieval observation and releases it afterwards', async t => {
    const calls = stubPlugin(t);
    const bridge = plugin.getContextBridge();
    const result = await bridge.recallMemory({
        query: 'q', diaries: ['notes'], k: 5, metaThinking: { pool: 'custom-pool', group: true }
    });
    assert.equal(result.metaFormula, '$$fixture-formula$$');
    assert.equal(calls.meta.length, 1);
    assert.equal(calls.meta[0].pool, 'custom-pool');
    assert.equal(calls.meta[0].group, true);
    assert.deepEqual(calls.meta[0].observation, { fake: 'observation' });
    assert.equal(calls.release.length, 1); // observation released exactly once
    assert.deepEqual(calls.release[0], { fake: 'observation' });
});

test('metaThinking failure degrades to null instead of failing the recall', async t => {
    const calls = stubPlugin(t);
    plugin.metaThinkingManager.processMetaThinkingV3 = async () => { throw new Error('solver exploded'); };
    const bridge = plugin.getContextBridge();
    const result = await bridge.recallMemory({ query: 'q', diaries: ['notes'], k: 5, metaThinking: true });
    assert.equal(result.metaFormula, null);
    assert.equal(result.direct.length, 1);
    assert.equal(calls.release.length, 1);
});

test('resolveStarPoolDiaries delegates to the manager', () => {
    const bridge = plugin.getContextBridge();
    assert.deepEqual(bridge.resolveStarPoolDiaries('a|b'), ['a', 'b']);
    const fallback = bridge.resolveStarPoolDiaries();
    assert.ok(Array.isArray(fallback) && fallback.length > 0 && fallback.every(name => typeof name === 'string'));
});

test('recallMemory rejects empty diaries and blank query before embedding', async () => {
    const bridge = plugin.getContextBridge();
    await assert.rejects(() => bridge.recallMemory({ query: 'q', diaries: [] }), /diaries required/);
    await assert.rejects(() => bridge.recallMemory({ query: '   ', diaries: ['notes'] }), /query required/);
});
