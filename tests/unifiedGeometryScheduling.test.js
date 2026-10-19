'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TagMemoEngine = require('../TagMemoEngine');

function fixture(overrides = {}) {
    const calls = [];
    const owner = {
        dbPath: 'fixture.sqlite',
        async onNativeMemoArtifactPublished() { calls.push('published'); }
    };
    const index = {
        async computeMemoGeometry() {
            calls.push('geometry');
            return { success: true, artifactSig: 'geometry', algorithmVersion: 'ags', configHash: 'cfg' };
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
    assert.deepEqual(calls, ['geometry', 'artifact', 'published']);
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