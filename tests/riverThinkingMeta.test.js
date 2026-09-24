'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MetaThinkingManager = require('../Plugin/RAGDiaryPlugin/MetaThinkingManager');

function fixture() {
    const calls = { search: [], plan: [], broadcast: [] };
    const host = {
        _generateCacheKey: value => JSON.stringify(value),
        _getCachedResult: () => null,
        _setCachedResult: () => {},
        cosineSimilarity: (a, b) => b[0],
        _getWeightedAverageVector: vectors => vectors[0],
        ragParams: {},
        pushVcpInfo: value => calls.broadcast.push(value),
        vectorDBManager: {
            async search(name, vector, k) {
                calls.search.push({ name, vector, k });
                return [{ chunkId: name === 'A' ? 1 : 2, text: `${name}正文\nTag: 标签甲,标签乙`, vector: [1, 0], score: 0.8 }];
            },
            async planRiverThinking(prepared, stages) {
                calls.plan.push({ prepared, stages });
                return {
                    artifactSig: 'artifact',
                    stages: stages.map((stage, index) => ({
                        ...stage,
                        results: stage.candidates.slice(0, stage.k).map(item => ({
                            ...item,
                            riverThinking: {
                                chunkId: item.chunkId, score: 0.7,
                                relation: index === 0 ? 'root' : 'continuation',
                                parents: index === 0 ? [] : [1],
                                route: { hop: index + 1 }
                            }
                        }))
                    }))
                };
            }
        }
    };
    const manager = new MetaThinkingManager(host);
    manager.metaThinkingChains = {
        chains: {
            default: { clusters: ['A', 'B'], kSequence: [2, 1] },
            coding: { clusters: ['A', 'B'], kSequence: [1, 0] },
            excluded: { clusters: ['B'], kSequence: [1] }
        }
    };
    manager.metaChainThemeVectors = { coding: [0.9], excluded: [1] };
    const prepared = { observationHandle: 'same-request', artifact: { artifactSig: 'artifact' } };
    const options = {
        config: { candidateK: 48, minClosure: 0.2 },
        getObservation: async () => prepared
    };
    return { manager, calls, host, options, prepared };
}

test('River meta preserves Auto whitelist and stage K including zero, using the supplied observation', async () => {
    const f = fixture();
    const text = await f.manager.processMetaThinkingChain(
        'default', [1, 0], 'query', '', 'display', null, false,
        true, 0.65, ['coding'], null, f.options
    );
    assert.equal(f.calls.plan.length, 1);
    assert.equal(f.calls.plan[0].prepared, f.prepared);
    assert.deepEqual(f.calls.plan[0].stages.map(s => s.k), [1, 0]);
    assert.equal(f.calls.search.length, 1);
    assert.equal(f.calls.search[0].k, 48);
    assert.match(text, /coding/);
    assert.match(text, /起始渠道/);
    assert.doesNotMatch(text, /Tag:/);
    assert.match(f.calls.plan[0].stages[0].candidates[0].text, /Tag:/);
    assert.equal(f.calls.broadcast[0].engine, 'rivermemo-sense');
});

test('no successful diary observation uses only the original recursive JS path', async () => {
    const f = fixture();
    f.options.getObservation = async () => null;
    const text = await f.manager.processMetaThinkingChain(
        'default', [1, 0], 'q', '', 'q', null, false,
        false, 0.65, null, null, f.options
    );
    assert.equal(f.calls.plan.length, 0);
    assert.deepEqual(f.calls.search.map(s => s.k), [2, 1]);
    assert.doesNotMatch(text, /Sense传播|Tag:/);
});

test('native planner rejection falls back to the entire original chain', async () => {
    const f = fixture();
    f.host.vectorDBManager.planRiverThinking = async () => { throw new Error('expired handle'); };
    const text = await f.manager.processMetaThinkingChain(
        'default', [1, 0], 'q', '', 'q', null, false,
        false, 0.65, null, null, f.options
    );
    assert.deepEqual(f.calls.search.map(s => s.k), [48, 48, 2, 1]);
    assert.match(text, /A正文/);
    assert.match(text, /B正文/);
    assert.doesNotMatch(text, /Sense传播|Tag:/);
});

test('tag sanitizer strips trailing metadata, preserving inline text and fenced examples', () => {
    const { manager } = fixture();
    assert.equal(manager._stripTagMetadata('正文\r\nTag: A\r\ntag：B\r\n'), '正文');
    assert.equal(manager._stripTagMetadata('正文没有标签'), '正文没有标签');
    assert.equal(manager._stripTagMetadata('正文中 Tag: 示例'), '正文中 Tag: 示例');
    assert.equal(manager._stripTagMetadata('Tag: 示例\n后续正文'), 'Tag: 示例\n后续正文');
    assert.equal(manager._stripTagMetadata('```\nTag: 示例\n```'), '```\nTag: 示例\n```');
    assert.equal(manager._stripTagMetadata('```\nTag: 示例'), '```\nTag: 示例');
    assert.equal(manager._stripTagMetadata('Tag: A'), '');
});

test('route display distinguishes supplements and analogy from supported dependencies', () => {
    const { manager } = fixture();
    const text = manager._formatMetaThinkingResults([{
        clusterName: 'A', stage: 1, results: [
            { text: '模块一\nTag: a,b', riverThinking: { chunkId: 1, relation: 'root', parents: [] } },
            { text: '模块二', riverThinking: { chunkId: 2, relation: 'analogy', parents: [1] } },
            { text: '模块三', riverThinking: { chunkId: 3, relation: 'supplement', parents: [] } }
        ]
    }], 'default', null);
    assert.match(text, /类比迁移（需验证）/);
    assert.match(text, /承接模块 1/);
    assert.match(text, /独立补充/);
    assert.doesNotMatch(text, /Tag:/);
});