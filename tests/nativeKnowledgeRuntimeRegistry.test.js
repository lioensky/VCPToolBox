'use strict';

const assert = require('assert');

const {
    VexusIndex,
    NativeKnowledgeRuntime
} = require('../rust-vexus-lite');

const DIMENSION = 8;

function vectorFor(id) {
    const output = new Float32Array(DIMENSION);
    output[0] = 1;
    output[1] = (id % 101) / 1010;
    return output;
}

async function run() {
    assert.strictEqual(
        typeof NativeKnowledgeRuntime,
        'function',
        'NativeKnowledgeRuntime must be exported by the binding'
    );

    const tagIndex = new VexusIndex(DIMENSION, 32);
    const runtime = new NativeKnowledgeRuntime(tagIndex);
    assert.strictEqual(
        typeof runtime.executeRiverQueryHybrid,
        'function',
        'Native Query Plan V2 ABI must be exported by the binding'
    );
    assert.deepStrictEqual(
        {
            acceptingQueries: runtime.stats().acceptingQueries,
            dimension: runtime.stats().dimension,
            registeredDiaries: runtime.stats().registeredDiaries
        },
        {
            acceptingQueries: true,
            dimension: DIMENSION,
            registeredDiaries: 0
        }
    );

    let oldIndex = new VexusIndex(DIMENSION, 64);
    oldIndex.add(1, vectorFor(1));
    const first = runtime.registerDiaryIndex('SharedMemory', oldIndex);
    assert.strictEqual(first.diaryName, 'SharedMemory');
    assert.strictEqual(first.generation, 1);
    assert.strictEqual(first.contentRevision, 1);
    assert.strictEqual(first.totalVectors, 1);

    // Runtime 保存纯 Rust Arc；丢弃当前 JS 局部引用不应撤销注册项。
    oldIndex = null;
    if (typeof global.gc === 'function') global.gc();
    assert.strictEqual(
        runtime.diaryIndexState('SharedMemory').totalVectors,
        1
    );

    const replacement = new VexusIndex(DIMENSION, 64);
    replacement.add(2, vectorFor(2));
    const second = runtime.registerDiaryIndex(
        'SharedMemory',
        replacement
    );
    assert(second.generation > first.generation);
    assert.strictEqual(
        runtime.unregisterDiaryIndex('SharedMemory', first.generation),
        false,
        'stale eviction generation must not remove a replacement index'
    );
    assert.strictEqual(
        runtime.diaryIndexState('SharedMemory').generation,
        second.generation
    );

    const revisionBefore = replacement.revision;
    const delta = await replacement.applyChunkDelta(
        [2],
        [3],
        vectorFor(3)
    );
    assert.strictEqual(delta.revision, revisionBefore + 1);
    const afterDelta = runtime.diaryIndexState('SharedMemory');
    assert.strictEqual(afterDelta.contentRevision, delta.revision);
    assert.strictEqual(afterDelta.totalVectors, 1);

    const another = new VexusIndex(DIMENSION, 32);
    another.addBatch(
        [3, 4],
        new Float32Array([
            ...vectorFor(3),
            ...vectorFor(4)
        ])
    );
    const anotherState = runtime.registerDiaryIndex(
        'AnotherMemory',
        another
    );
    assert.deepStrictEqual(
        runtime.listDiaryIndices().map(item => item.diaryName),
        ['AnotherMemory', 'SharedMemory'],
        'registry diagnostics must be deterministic'
    );
    assert.strictEqual(runtime.stats().registeredDiaries, 2);

    const annPayload = await runtime.searchDiaryIndices(
        ['SharedMemory', 'AnotherMemory', 'SharedMemory'],
        vectorFor(3),
        8,
        8
    );
    const ann = JSON.parse(annPayload);
    assert.strictEqual(
        ann.schema,
        'vcp-native-multi-index-ann-result-v1'
    );
    assert.strictEqual(ann.diagnostics.requestedDiaries, 2);
    assert.strictEqual(ann.diagnostics.resolvedIndices, 2);
    assert.strictEqual(ann.diagnostics.annCandidates, 3);
    assert.strictEqual(ann.diagnostics.uniqueCandidates, 2);
    assert.strictEqual(ann.results.length, 2);
    const sharedChunk = ann.results.find(item => Number(item.id) === 3);
    assert(sharedChunk, 'cross-index duplicate Chunk must be retained once');
    assert.deepStrictEqual(
        sharedChunk.sources,
        ['AnotherMemory', 'SharedMemory']
    );
    assert.deepStrictEqual(
        ann.diagnostics.indices.map(item => item.diaryName),
        ['AnotherMemory', 'SharedMemory'],
        'ANN lock acquisition and diagnostics must use deterministic diary order'
    );
    const sharedSnapshot = ann.diagnostics.indices.find(
        item => item.diaryName === 'SharedMemory'
    );
    assert.strictEqual(sharedSnapshot.generation, second.generation);
    assert.strictEqual(sharedSnapshot.contentRevision, delta.revision);
    const anotherSnapshot = ann.diagnostics.indices.find(
        item => item.diaryName === 'AnotherMemory'
    );
    assert.strictEqual(anotherSnapshot.generation, anotherState.generation);

    const reversePayload = await runtime.searchDiaryIndices(
        ['AnotherMemory', 'SharedMemory'],
        vectorFor(3),
        8,
        8
    );
    assert.deepStrictEqual(
        JSON.parse(reversePayload).results,
        ann.results,
        'input diary order must not change merged ANN results'
    );
    assert.throws(
        () => runtime.searchDiaryIndices(
            ['SharedMemory', 'MissingMemory'],
            vectorFor(3),
            8,
            8
        ),
        /not registered/i
    );

    assert.throws(
        () => runtime.executeRiverQueryHybrid(
            'unused.sqlite',
            'unused-artifact',
            JSON.stringify({ observationHandle: 'unused-observation' }),
            ['SharedMemory'],
            vectorFor(3),
            new Float32Array(DIMENSION + 1),
            JSON.stringify({
                schema: 'vcp-native-hybrid-query-plan-v2'
            }),
            8,
            8,
            0.92
        ),
        /not divisible by dimension/i,
        'malformed flattened supplemental vectors must fail before data-plane work'
    );

    const wrongDimension = new VexusIndex(DIMENSION / 2, 16);
    assert.throws(
        () => runtime.registerDiaryIndex('WrongDimension', wrongDimension),
        /dimension mismatch/i
    );
    assert.strictEqual(runtime.stats().registeredDiaries, 2);

    assert.strictEqual(
        runtime.unregisterDiaryIndex('SharedMemory', second.generation),
        true
    );
    assert.strictEqual(runtime.diaryIndexState('SharedMemory'), null);
    assert.strictEqual(runtime.stats().registeredDiaries, 1);

    runtime.shutdown();
    const stopped = runtime.stats();
    assert.strictEqual(stopped.acceptingQueries, false);
    assert.strictEqual(stopped.registeredDiaries, 0);
    assert.throws(
        () => runtime.registerDiaryIndex('AfterShutdown', another),
        /shutting down/i
    );

    console.log(
        '[NativeKnowledgeRuntimeRegistryTest] PASS: instance ownership, ' +
        'generation-safe replacement, shared revision, hybrid ABI validation ' +
        'and shutdown verified.'
    );
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});