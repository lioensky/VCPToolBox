'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TagMemoEngine = require('../TagMemoEngine');

function fixture(overrides = {}) {
    const calls = [];
    const owner = {
        dbPath: 'fixture.sqlite',
        config: { modelSig: 'chunk-model' },
        nativeKnowledgeRuntime: {
            async prepareGlobalWarpedChunkIndex(model, force) {
                assert.equal(model, 'chunk-model');
                assert.equal(force, true);
                calls.push('warped-chunks');
                return JSON.stringify({ ready: true, forced: true, source: 'built', nodes: 12 });
            }
        },
        async onNativeMemoArtifactPublished() { calls.push('published'); }
    };
    const index = {
        async computeMemoGeometry() {
            calls.push('geometry');
            return { success: true, artifactSig: 'geometry', algorithmVersion: 'ags', configHash: 'cfg' };
        },
        async warmupWarpedTagField(db, sig, preset, force) {
            assert.equal(db, 'fixture.sqlite');
            assert.equal(sig, 'runtime');
            assert.equal(preset, 'locked_2');
            assert.equal(force, true);
            calls.push('warped-tags');
            return JSON.stringify({ source: 'built', forced: true, nodes: 8 });
        },
        async rebuildMemoArtifact() {
            calls.push('artifact');
            return { success: true, artifactSig: 'runtime', sourceArtifactSig: 'source',
                persisted: true, resident: true };
        },
        ...overrides
    };
    return { engine: new TagMemoEngine(null, index, {}, {}, owner), calls, owner };
}

test('every rebuild executes geometry before artifact and awaits publication', async () => {
    const { engine, calls, owner } = fixture();
    engine._accumulatedNewTagIds.add(1);
    owner.onNativeMemoArtifactPublished = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        engine._accumulatedNewTagIds.add(2);
        calls.push('published');
    };
    assert.equal(await engine.doMatrixRebuild({ reason: 'incremental' }), true);
    assert.deepEqual(calls, ['geometry', 'artifact', 'published']);
    assert.deepEqual([...engine._accumulatedNewTagIds], [2]);
    assert.equal(engine.geometryArtifact.artifactSig, 'geometry');
});

test('revision conflict retries once, then rejects without building an artifact', async () => {
    let count = 0;
    const { engine, calls } = fixture({
        async computeMemoGeometry() {
            count++;
            throw new Error('revision_conflict');
        }
    });
    await assert.rejects(engine.doMatrixRebuild(), /revision_conflict/);
    assert.equal(count, 2);
    assert.deepEqual(calls, []);
    assert.equal(engine._isMatrixRebuilding, false);
});

test('a transient facts conflict recovers within the bounded retry', async () => {
    let count = 0;
    const { engine } = fixture({
        async computeMemoGeometry() {
            if (++count === 1) throw new Error('KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT');
            return { success: true, artifactSig: 'fresh' };
        }
    });
    assert.equal(await engine.doMatrixRebuild(), true);
    assert.equal(count, 2);
});

test('geometry config uses new section or legacy local fallback without sharing mutable state', () => {
    const { engine } = fixture();
    engine.ragParams = { KnowledgeBaseManager: { intrinsicResidual: { maxBasis: 7 } } };
    assert.equal(engine._geometryConfig().local.maxBasis, 7);
    engine.ragParams.KnowledgeBaseManager.geometry = { local: { maxBasis: 3 } };
    const snapshot = engine._geometryConfig();
    snapshot.local.maxBasis = 99;
    assert.equal(engine._geometryConfig().local.maxBasis, 3);
});

test('health failure prevents downstream artifact construction', async () => {
    const { engine, calls, owner } = fixture();
    owner.nativeKnowledgeRuntime = { async healthCheck() { return { healthy: false }; } };
    await assert.rejects(engine.doMatrixRebuild(), /unhealthy/);
    assert.deepEqual(calls, ['geometry']);
});

test('manual requests reuse queued and running training and expose completion', async () => {
    let release;
    const { engine, calls } = fixture({
        async computeMemoGeometry() {
            calls.push('geometry');
            await new Promise(resolve => { release = resolve; });
            return { success: true, artifactSig: 'geometry' };
        }
    });
    const first = engine.requestActiveFullTraining();
    assert.equal(engine.requestActiveFullTraining().taskId, first.taskId);
    clearTimeout(engine._derivedTaskTimer);
    const running = engine._processDerivedTaskQueue();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.getTrainingStatus().status, 'running');
    assert.equal(engine.getTrainingStatus().phase, 'geometry');
    const duplicate = engine.requestActiveFullTraining();
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(engine._derivedTaskQueue.length, 1);
    release();
    await running;
    assert.equal(engine.getTrainingStatus().status, 'completed');
    assert.equal(engine.getTrainingStatus().artifactSig, 'runtime');
    assert.deepEqual(calls, ['geometry', 'artifact', 'published', 'warped-tags', 'warped-chunks']);
    assert.equal(engine.getTrainingStatus().warped.tag.nodes, 8);
    assert.equal(engine.getTrainingStatus().warped.chunks.nodes, 12);
    await engine.shutdown();
});

test('same resident native asset does not publish a second JS generation', async () => {
    const { engine, calls } = fixture();
    await engine.doMatrixRebuild();
    const first = engine.getArtifactBundleSnapshot();
    await engine.doMatrixRebuild();
    assert.equal(engine.getArtifactBundleSnapshot(), first);
    assert.equal(calls.filter(call => call === 'published').length, 1);
    await engine.shutdown();
});

test('failed training remains observable after leaving the queue', async () => {
    const { engine } = fixture({
        async computeMemoGeometry() { throw new Error('fixture failure'); }
    });
    engine.requestActiveFullTraining();
    clearTimeout(engine._derivedTaskTimer);
    await engine._processDerivedTaskQueue();
    assert.equal(engine.getTrainingStatus().status, 'failed');
    assert.match(engine.getTrainingStatus().error, /fixture failure/);
    await engine.shutdown();
});

test('failed companion publication retries without incrementing the V9 generation', async () => {
    const { engine, owner } = fixture();
    let attempts = 0;
    owner.onNativeMemoArtifactPublished = async () => {
        if (++attempts === 1) throw new Error('companion publication failed');
    };
    await assert.rejects(engine.doMatrixRebuild(), /companion publication failed/);
    const first = engine.getArtifactBundleSnapshot();
    await engine.doMatrixRebuild();
    assert.equal(attempts, 2);
    assert.equal(engine.getArtifactBundleSnapshot(), first);
    await engine.shutdown();
});

test('facts committed during a running training retain a follow-up task', async () => {
    const { engine } = fixture();
    engine._derivedTaskQueue.push({ id: 'running', type: 'threshold-rebuild', status: 'running' });
    const next = engine.requestActiveFullTraining({ reason: 'tag-consistency-commit' });
    assert.notEqual(next.taskId, 'running');
    assert.equal(engine._derivedTaskQueue.length, 2);
    engine._derivedTaskQueue = [];
    await engine.shutdown();
});

test('warped maintenance failure reports partial publication and failed stage', async () => {
    const { engine, calls, owner } = fixture();
    owner.nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex = async () => {
        calls.push('warped-chunks');
        throw new Error('injected sidecar failure');
    };
    engine.requestActiveFullTraining();
    clearTimeout(engine._derivedTaskTimer);
    await engine._processDerivedTaskQueue();
    const status = engine.getTrainingStatus();
    assert.equal(status.status, 'failed');
    assert.equal(status.failedPhase, 'warped-chunks');
    assert.match(status.error, /already published.*injected sidecar failure/);
    assert.equal(status.artifactSig, 'runtime');
    assert.equal(status.warped.tag.source, 'built');
    assert.equal(engine.getArtifactBundleSnapshot().runtimeArtifactSig, 'runtime');
    await engine.shutdown();
});

test('manual full training is not silently satisfied by a threshold-only task', async () => {
    const { engine } = fixture();
    engine._derivedTaskQueue.push({ id: 'automatic', type: 'threshold-rebuild', status: 'running' });
    const result = engine.requestActiveFullTraining();
    assert.equal(result.queued, true);
    assert.notEqual(result.taskId, 'automatic');
    assert.equal(engine._derivedTaskQueue.length, 2);
    engine._derivedTaskQueue = [];
    await engine.shutdown();
});

test('missing native warped ABI fails before publishing any new base assets', async () => {
    const { engine, calls, owner } = fixture();
    owner.nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex = undefined;
    await assert.rejects(engine.doMatrixRebuild({ includeWarped: true }), /matching native module/);
    assert.deepEqual(calls, []);
    assert.equal(engine._isMatrixRebuilding, false);
    await engine.shutdown();
});

test('1% durable Tag boundary rebuilds both warped fields, below threshold does nothing', async () => {
    const { engine, calls, owner } = fixture();
    let changed = 999;
    owner._buildNativeMemoEffectiveConfig = () => ({});
    owner._computeNativeMemoConfigHash = () => 'cfg';
    owner.nativeKnowledgeRuntime.getNativeMemoManifest = async () => ({
        trainingTagCount: 100000, changedTagCount: changed
    });
    engine._getMatrixRebuildQuietMs = () => 0;
    // Exercise the actual threshold timer, but run the queue deterministically.
    engine._scheduleDerivedTaskPump = () => {};
    assert.equal(await engine.scheduleMatrixRebuildForNewTags([1]), false);
    assert.equal(engine._matrixRebuildTimer, null);
    assert.deepEqual(calls, []);
    changed = 1000;
    assert.equal(await engine.scheduleMatrixRebuildForNewTags([]), true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine._derivedTaskQueue.length, 1);
    assert.equal(engine._derivedTaskQueue[0].type, 'threshold-rebuild');
    await engine._processDerivedTaskQueue();
    assert.equal(engine.getTrainingStatus().status, 'completed');
    assert.deepEqual(calls, ['geometry', 'artifact', 'published', 'warped-tags', 'warped-chunks']);
    assert.equal(engine.getTrainingStatus().warped.chunks.source, 'built');
    await engine.shutdown();
});

test('automatic warped training failures retain the failed phase and published base identity', async () => {
    const { engine, owner } = fixture();
    owner._buildNativeMemoEffectiveConfig = () => ({});
    owner._computeNativeMemoConfigHash = () => 'cfg';
    owner.nativeKnowledgeRuntime.getNativeMemoManifest = async () => ({
        trainingTagCount: 100000, changedTagCount: 1000
    });
    owner.nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex = async () => {
        throw new Error('automatic warped failure');
    };
    engine._getMatrixRebuildQuietMs = () => 0;
    engine._scheduleDerivedTaskPump = () => {};
    await engine.scheduleMatrixRebuildForNewTags([]);
    await new Promise(resolve => setTimeout(resolve, 10));
    engine._derivedTaskQueue[0].maxAttempts = 1;
    await engine._processDerivedTaskQueue();
    assert.equal(engine.getTrainingStatus().status, 'failed');
    assert.equal(engine.getTrainingStatus().failedPhase, 'warped-chunks');
    assert.match(engine.getTrainingStatus().error, /already published.*automatic warped failure/);
    assert.equal(engine.getTrainingStatus().artifactSig, 'runtime');
    await engine.shutdown();
});