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