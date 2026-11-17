'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../KnowledgeBaseManager');
const formatter = require('../Plugin/RAGDiaryPlugin/RAGResultFormatter');

test('production LightMemo prepares only warped observation and releases it', async () => {
    const calls = [];
    const released = [];
    const owner = {
        config: { modelSig: 'fixture', rootPath: '.' },
        async prepareUnifiedMemoObservation(_query, options) {
            calls.push(options.tagRoutingMode);
            return {
                artifact: { artifactSig: 'a' }, observationHandle: 'warped',
                sourceObservationResult: {
                    diagnostics: { nativePipeline: { tagRouting: { used: 'warped_ags' } } }
                }
            };
        },
        releaseMemoObservation(value) { released.push(value.observationHandle); },
        riverMemoEngine: { _nativeConfig: () => ({}) },
        nativeKnowledgeRuntime: {
            async executeLightMemoQuery(raw) {
                const plan = JSON.parse(raw);
                assert.equal(plan.riverInput, null);
                assert.equal(plan.warpedRiverInput.observationHandle, 'warped');
                assert.equal(plan.modelSig, 'fixture');
                return { schema: 'vcp-lightmemo-result-v1', results: [] };
            }
        }
    };
    await kb._executeLightMemoQueryAdmitted.call(owner, { vector: [1, 0] });
    assert.deepEqual(calls, ['warped_ags']);
    assert.deepEqual(released, ['warped']);
    owner.prepareUnifiedMemoObservation = async () => {
        throw Object.assign(new Error('not trained'), { code: 'MEMO_ARTIFACT_UNAVAILABLE' });
    };
    owner.nativeKnowledgeRuntime.executeLightMemoQuery = async raw => {
        const plan = JSON.parse(raw);
        assert.equal(plan.riverInput, null);
        assert.equal(plan.warpedRiverInput, null);
        return { schema: 'vcp-lightmemo-result-v1', results: [] };
    };
    await kb._executeLightMemoQueryAdmitted.call(owner, { vector: [1, 0] });
    owner.prepareUnifiedMemoObservation = async () => { throw new Error('CRC mismatch'); };
    await assert.rejects(kb._executeLightMemoQueryAdmitted.call(owner,
        { vector: [1, 0] }), /CRC mismatch/);
});

test('native River with unready warped Tags falls back to ANN without old index load', async () => {
    let releases = 0;
    const owner = {
        config: { dimension: 2, nativeRiverQueryEnabled: true },
        async getFileIdsByDiaries() { return [10]; },
        async _getOrLoadDiaryIndex() { throw new Error('old index loaded'); },
        async prepareUnifiedMemoObservation(_query, options) {
            assert.equal(options.tagRoutingMode, 'warped_ags');
            return { observationHandle: 'q',
                sourceObservationResult: {
                    diagnostics: { nativePipeline: { tagRouting: { used: 'cosine' } } }
                } };
        },
        releaseMemoObservation() { releases++; },
        async searchKnn(names, _vector, _k, options) {
            assert.deepEqual(names, ['A']);
            assert.deepEqual(options.allowedFileIds, [10]);
            return [{ id: 1, retrievalEngine: 'warped_ann' }];
        }
    };
    const result = await kb.executeNativeRiverQuery.call(owner,
        { vector: [1, 0] }, { diaryNames: ['A'], topK: 1 });
    assert.equal(result.diagnostics.retrievalEngine, 'warped_ann');
    assert.equal(result.diagnostics.degraded, true);
    assert.equal(releases, 1);
});

test('RAG prompts distinguish RiverMemo V5 from warped ANN fallback', () => {
    const row = { text: 'memory', source: 'rag' };
    const ordinary = formatter.formatStandardResults([row], 'A', { retrievalEngine: 'rivermemo_v5' });
    assert.match(ordinary, /RiverMemo V5/);
    assert.match(ordinary, /双曲 Chunk/);
    const degraded = formatter.formatStandardResults([row], 'A', { retrievalEngine: 'warped_ann' });
    assert.match(degraded, /双曲 ANN 兜底/);
    assert.match(degraded, /本次不可用/);
});