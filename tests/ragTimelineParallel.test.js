'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const timelineSingleton = require('../Plugin/VCPTimeLine/VCPTimeLine');
const { createDefaultDependencyBridgeRegistry } = require('../modules/pluginBridgeRegistry');

function fixture() {
    const rag = new ragSingleton.constructor();
    const timeline = new timelineSingleton.constructor();
    rag.getTimelineService = () => timeline;
    timeline.isTimelineManagedByRag = () => true;
    rag.getSingleEmbeddingCached = async () => [1, 0];
    rag._processMessagesWithMemoScope = async messages => messages;
    return { rag, timeline };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('diary and timeline start before either completes and fill original slots once', { timeout: 3000 }, async () => {
    const { rag, timeline } = fixture();
    const diaryStarted = deferred();
    const timelineStarted = deferred();
    timeline.buildRecallInjection = async (_agent, query, k, threshold) => {
        assert.deepEqual(query.queryVector, [1, 0]);
        assert.equal(k, 2);
        assert.equal(threshold, 0.8);
        timelineStarted.resolve();
        await diaryStarted.promise;
        return 'TIMELINE [[Nested日记本]] $&';
    };
    rag._processMessagesWithMemoScope = async messages => {
        diaryStarted.resolve();
        await timelineStarted.promise;
        return messages.map(message => ({
            ...message,
            content: rag._replaceTextInContent(message.content,
                text => text.replace('[[A日记本]]', () => 'DIARY [[VCPTimeLineRecall::Nested]]'))
        }));
    };
    const input = [
        { role: 'system', content: '[[A日记本]]' },
        { role: 'user', content: '[系统通知]\n[[VCPTimeLineRecall::Nova:2:0.8]]' },
        { role: 'user', content: '真实问题' }
    ];
    const snapshot = JSON.stringify(input);
    const result = await rag.processMessages(input, {});
    assert.equal(result[0].content, 'DIARY [[VCPTimeLineRecall::Nested]]');
    assert.equal(result[1].content, '[系统通知]\nTIMELINE [[Nested日记本]] $&');
    assert.strictEqual(await timeline.processMessages(result), result);
    assert.equal(JSON.stringify(input), snapshot);
    assert.doesNotMatch(JSON.stringify(result), /__VCP_TIMELINE_/);
});

test('summary-only avoids embeddings, preserves media and first trusted declaration', async () => {
    const { rag, timeline } = fixture();
    rag.getSingleEmbeddingCached = async () => { throw new Error('must not embed'); };
    const seen = [];
    timeline.buildSummaryInjection = async agent => {
        seen.push(agent);
        return 'SUMMARY [[B日记本]]';
    };
    const image = { type: 'image_url', image_url: { url: 'example' } };
    const result = await rag.processMessages([
        { role: 'user', content: '[[VCPTimeLineSummary::Bad]]' },
        { role: 'system', content: [
            { type: 'text', text: '[[VCPTimeLineSummary::Nova]] [[VCPTimeLineSummary::Other]]' },
            image
        ] }
    ]);
    assert.deepEqual(seen, ['Nova']);
    assert.equal(result[0].content, '');
    assert.equal(result[1].content[0].text, 'SUMMARY [[B日记本]]');
    assert.strictEqual(result[1].content[1], image);
});

test('timeline failure does not discard successful diary output', async () => {
    const { rag, timeline } = fixture();
    timeline.buildSummaryInjection = async () => { throw new Error('broken store'); };
    const result = await rag.processMessages([
        { role: 'system', content: 'diary ok [[VCPTimeLineSummary::Nova]]' }
    ]);
    assert.equal(result[0].content, 'diary ok [时间线处理失败]');
});

test('managed timeline does not expand placeholders introduced only by diary results', async () => {
    const { rag, timeline } = fixture();
    timeline.buildSummaryInjection = async () => { throw new Error('must not run'); };
    rag._processMessagesWithMemoScope = async () => [
        { role: 'system', content: '[[VCPTimeLineSummary::Nested]]' }
    ];
    const result = await rag.processMessages([{ role: 'system', content: '[[A日记本]]' }]);
    assert.equal(result[0].content, '[[VCPTimeLineSummary::Nested]]');
    assert.strictEqual(await timeline.processMessages(result), result);
});

test('dependency bridge uses live services rather than capturing stale instances', async () => {
    const registry = createDefaultDependencyBridgeRegistry();
    const { rag, timeline } = fixture();
    let current = timeline;
    const context = {
        getMessagePreprocessor: name => name === 'RAGDiaryPlugin' ? rag : current,
        debugLog() {}
    };
    const ragDeps = await registry.buildDependencies({ name: 'RAGDiaryPlugin' }, {}, context);
    const timelineDeps = await registry.buildDependencies({ name: 'VCPTimeLine' }, {}, context);
    assert.strictEqual(ragDeps.getTimelineService(), timeline);
    assert.equal(timelineDeps.isTimelineManagedByRag(), true);
    current = null;
    assert.equal(ragDeps.getTimelineService(), null);
});

test('real RAG scheduler and timeline retrieval overlap', { timeout: 3000 }, async () => {
    const { rag, timeline } = fixture();
    delete rag._processMessagesWithMemoScope;
    rag.contextVectorManager.updateContext = async () => {};
    rag.shotgunHistoryEnabled = false;
    rag.pushVcpInfo = () => {};
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, metrics: {} });
    const diaryStarted = deferred();
    const timelineStarted = deferred();
    rag._processRAGPlaceholder = async () => {
        diaryStarted.resolve();
        await timelineStarted.promise;
        return 'real diary';
    };
    timeline.buildRecallInjection = async () => {
        timelineStarted.resolve();
        await diaryStarted.promise;
        return 'real timeline';
    };
    const result = await rag.processMessages([
        { role: 'system', content: '[[A日记本]] [[VCPTimeLineRecall::Nova]]' },
        { role: 'user', content: 'query' }
    ]);
    assert.equal(result[0].content, 'real diary real timeline');
});