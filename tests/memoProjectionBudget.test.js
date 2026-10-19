'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../KnowledgeBaseManager');
const { cleanRiverConfig } = require('../modules/knowledgeBase/memoConfig');

function fixture() {
    const owner = Object.create(kb);
    const calls = [];
    const released = [];
    owner.config = { dimension: 2 };
    owner.ragParams = { KnowledgeBaseManager: {
        riverMemo: { effectiveSupport: { maxProjectionNodes: 128 } }
    } };
    owner._resolveUnifiedMemoRuntime = () => ({
        dbPath: 'fixture.sqlite',
        artifact: { artifactSig: 'fixture', effectiveConfig: {} }
    });
    owner.tagIndex = {
        releaseMemoObservation(handle) { released.push(handle); return true; }
    };
    owner._runMemoPipelineShared = async (db, sig, json) => {
        calls.push(JSON.parse(json));
        return {
            metadataJson: JSON.stringify({
                artifactSig: 'fixture', observationHandle: 'owned', diagnostics: {}
            }),
            enhancedVector: new Float32Array([1, 0])
        };
    };
    return { owner, calls, released };
}

test('projection config whitelist retains arbitrary integer and zero budgets', () => {
    assert.equal(cleanRiverConfig({}, true).effectiveSupport.maxProjectionNodes, 256);
    for (const k of [0, 64, 128, 193, 256, 512, 4097]) {
        assert.equal(cleanRiverConfig({
            effectiveSupport: { maxProjectionNodes: k }
        }).effectiveSupport.maxProjectionNodes, k);
    }
});

test('query projection budget overrides nested and configured values without losing zero', async () => {
    const { owner, calls } = fixture();
    const query = { vector: [1, 0] };
    await owner.prepareUnifiedMemoObservation(query);
    await owner.prepareUnifiedMemoObservation(query, { effectiveSupport: { maxProjectionNodes: 193 } });
    await owner.prepareUnifiedMemoObservation(query, {
        effectiveSupport: { maxProjectionNodes: 512 }, maxFieldProjectionNodes: 0
    });
    assert.deepEqual(calls.map(call => call.config.maxFieldProjectionNodes), [128, 193, 0]);
    delete owner.ragParams.KnowledgeBaseManager.riverMemo.effectiveSupport.maxProjectionNodes;
    await owner.prepareUnifiedMemoObservation(query);
    assert.equal(calls[3].config.maxFieldProjectionNodes, 256);
});

test('invalid projection budgets fail before native work', async () => {
    const { owner, calls } = fixture();
    for (const value of [-1, 1.5, Infinity, NaN, '256', Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(owner.prepareUnifiedMemoObservation(
            { vector: [1, 0] }, { maxFieldProjectionNodes: value }
        ), /non-negative safe integer/);
    }
    assert.equal(calls.length, 0);
});

test('invalid native output releases its already-created observation', async () => {
    const { owner, released } = fixture();
    owner._runMemoPipelineShared = async () => ({
        metadataJson: JSON.stringify({ artifactSig: 'wrong', observationHandle: 'owned' }),
        enhancedVector: new Float32Array([1, 0])
    });
    await assert.rejects(owner.prepareUnifiedMemoObservation({ vector: [1, 0] }),
        /artifact\/schema validation/);
    assert.deepEqual(released, ['owned']);
});