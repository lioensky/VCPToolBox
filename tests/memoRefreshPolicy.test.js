'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TagMemoEngine = require('../TagMemoEngine');

function fixture() {
    const state = { trainingTagCount: 10000, changedTagCount: 99 };
    const owner = {
        dbPath: 'unused-test-path',
        _buildNativeMemoEffectiveConfig: () => ({}),
        _computeNativeMemoConfigHash: () => 'hash',
        nativeKnowledgeRuntime: {
            async getNativeMemoManifest() { return JSON.stringify(state); }
        }
    };
    const engine = new TagMemoEngine(null, {}, { dimension: 2 }, {}, owner);
    engine._getMatrixRebuildQuietMs = () => 60000;
    return { engine, state };
}

test('1% uses persisted training baseline and unique changed Tags, including restart', async () => {
    const { engine, state } = fixture();
    try {
        assert.equal(await engine.scheduleMatrixRebuildForNewTags([999]), false);
        assert.equal(engine._getMatrixRebuildThreshold(), 100);
        state.changedTagCount = 100;
        assert.equal(await engine.scheduleMatrixRebuildForNewTags([]), true);
        const timer = engine._matrixRebuildTimer;
        state.changedTagCount = 120;
        await engine.scheduleMatrixRebuildForNewTags([]);
        assert.equal(engine._matrixRebuildTimer, timer, 'continuous writes must not reset deadline');
        assert.equal(engine._accumulatedTagChanges, 120);
    } finally {
        await engine.shutdown();
    }
});

test('small baselines round up to at least one Tag', () => {
    const { engine } = fixture();
    for (const [count, threshold] of [[0, 1], [1, 1], [100, 1], [101, 2], [37125, 372]]) {
        engine._trainingTagCount = count;
        assert.equal(engine._getMatrixRebuildThreshold(), threshold);
    }
});

test('failed training retains last published graph and durable refresh budget', async () => {
    const { engine, state } = fixture();
    const previous = Object.freeze({ artifactSig: 'old', runtimeArtifactSig: 'old-native' });
    engine._activeArtifactBundle = previous;
    engine.recomputeGeometry = async () => { throw new Error('injected failure'); };
    try {
        await assert.rejects(engine.doMatrixRebuild(), /injected failure/);
        assert.equal(engine.getArtifactBundleSnapshot(), previous);
        assert.equal(state.changedTagCount, 99);
        assert.equal(engine._isMatrixRebuilding, false);
    } finally {
        await engine.shutdown();
    }
});

test('running training does not queue a competing threshold job', async () => {
    const { engine, state } = fixture();
    state.changedTagCount = 100;
    engine._isMatrixRebuilding = true;
    try {
        assert.equal(await engine.scheduleMatrixRebuildForNewTags([]), true);
        assert.equal(engine._matrixRebuildTimer, null);
    } finally {
        engine._isMatrixRebuilding = false;
        await engine.shutdown();
    }
});