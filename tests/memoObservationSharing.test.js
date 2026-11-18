'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../KnowledgeBaseManager');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

function fixture() {
    const calls = [];
    const released = [];
    const owner = Object.create(kb);
    owner.tagIndex = {
        async runMemoPipeline(...args) {
            calls.push(args);
            await new Promise(resolve => setImmediate(resolve));
            return {
                metadataJson: JSON.stringify({ observationHandle: `handle-${calls.length}` }),
                enhancedVector: new Float32Array([1, 0])
            };
        },
        releaseMemoObservation(handle) { released.push(handle); return true; }
    };
    const run = (vector = new Float32Array([1, 0]), input = '{}', sig = 'a',
        ghosts = new Float32Array()) =>
        owner._runMemoPipelineShared('test.sqlite', sig, input, vector, ghosts);
    return { owner, calls, released, run };
}

test('parallel and sequential index consumers share one pipeline and defer release', async () => {
    const f = fixture();
    await f.owner.withMemoObservationScope(async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => f.run()));
        assert.equal(f.calls.length, 1);
        assert(results.every(result => result === results[0]));
        assert.equal(await f.run(), results[0]);
        assert.equal(f.owner.releaseMemoObservation({ observationHandle: 'handle-1' }), false);
        assert.deepEqual(f.released, []);
        await f.owner.withMemoObservationScope(() => f.run());
        assert.equal(f.calls.length, 1);
    });
    assert.deepEqual(f.released, ['handle-1']);
});

test('full vector, ghost payload, config and artifact differences do not merge', async () => {
    const f = fixture();
    await f.owner.withMemoObservationScope(async () => {
        const vector = new Float32Array(128).fill(1);
        const changed = vector.slice();
        changed[127] = 1.00001;
        await f.run(vector);
        await f.run(changed);
        await f.run(vector, '{"config":{"alpha":0.2}}');
        await f.run(vector, '{}', 'b');
        await f.run(vector, '{}', 'a', new Float32Array([0, 1]));
        assert.equal(f.calls.length, 5);
    });
    assert.equal(f.released.length, 5);
});

test('independent concurrent requests never borrow each other observations', async () => {
    const f = fixture();
    await Promise.all([
        f.owner.withMemoObservationScope(() => f.run()),
        f.owner.withMemoObservationScope(() => f.run())
    ]);
    assert.equal(f.calls.length, 2);
});

test('pipeline failures merge within a request, and successful handles release on exception', async () => {
    const f = fixture();
    let failures = 0;
    const original = f.owner.tagIndex.runMemoPipeline;
    f.owner.tagIndex.runMemoPipeline = async (...args) => {
        if (JSON.parse(args[2]).fail) { failures++; throw new Error('sense failed'); }
        return original(...args);
    };
    await assert.rejects(f.owner.withMemoObservationScope(async () => {
        const failed = await Promise.allSettled([
            f.run(undefined, '{"fail":true}'), f.run(undefined, '{"fail":true}')
        ]);
        assert(failed.every(item => item.status === 'rejected'));
        assert.equal(failures, 1);
        await f.run();
        throw new Error('readout failed');
    }), /readout failed/);
    assert.deepEqual(f.released, ['handle-1']);
});

test('meta readout starts after sensing but before diary readout completes', async () => {
    const host = Object.create(rag);
    let metaStarted = false;
    let diaryFinished = false;
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    host.vectorDBManager = {};
    host.directDiaryTextProcessor = { async tryProcessMessages() { return { processed: false }; } };
    host.contextVectorManager = {
        async updateContext() {},
        segmentContext() { return []; }
    };
    host.foldingStore = null;
    host.riverThinkingConfig = { enabled: true };
    host._resolveGhostAnchors = async () => [];
    host.getSingleEmbeddingCached = async () => [1, 0];
    host._getWeightedAverageVector = () => [1, 0];
    host._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.2, metrics: {} });
    host.timeParser = { parse: () => [] };
    host._processSingleSystemMessage = async (...args) => {
        const cache = args[args.length - 1];
        cache.riverThinking.deferred.push({
            token: 'pending-meta',
            run: async () => {
                await cache.riverThinking.ready[0].promise;
                assert.equal(diaryFinished, false);
                metaStarted = true;
                unblock();
                return { content: 'meta-result' };
            }
        });
        await new Promise(resolve => setImmediate(resolve));
        cache.riverThinking.ready[0].resolve();
        await blocked;
        diaryFinished = true;
        return 'pending-meta diary-result';
    };
    const result = await host.processMessages([
        { role: 'system', content: '[[A日记本]][[VCP元思考]]' },
        { role: 'user', content: 'query' }
    ], {});
    assert.equal(metaStarted, true);
    assert.equal(diaryFinished, true);
    assert.match(result[0].content, /meta-result diary-result/);
});