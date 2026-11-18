'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');

test('::TimeDecay alone does not enable ::Time', () => {
    for (const modifiers of [
        '::TimeDecay',
        '::TimeDecay30',
        '::TimeDecay30/0.5',
        '::TimeDecay30/0.5/box',
        '::RiverMemo::TimeDecay180/0::Truncate0.25'
    ]) {
        assert.equal(rag._hasTimeModifier(modifiers), false, modifiers);
    }
});

test('explicit ::Time keeps every accepted form', () => {
    for (const modifiers of [
        '::Time',
        '::Time0.3',
        '::Time.3',
        '::time',
        '::Time::Group',
        '::Time0.5::Group',
        '::Time::TimeDecay',
        '::TimeDecay30::Time',
        '::Time0.4::TimeDecay180/0',
        ':1.5::Time::Group::RiverMemo::Rerank+0.7::TimeDecay::Truncate0.25'
    ]) {
        assert.equal(rag._hasTimeModifier(modifiers), true, modifiers);
    }
    for (const modifiers of ['', '::Group', null, undefined]) {
        assert.equal(rag._hasTimeModifier(modifiers), false, String(modifiers));
    }
});

test('time ratio is read from ::Time, not from ::TimeDecay', () => {
    assert.equal(rag._extractTimeRatio('::Time0.4::TimeDecay180/0'), 0.4);
    assert.equal(rag._extractTimeRatio('::TimeDecay30::Time0.4'), 0.4);
    assert.equal(rag._extractTimeRatio('::Time::TimeDecay30'), 0.2);
    assert.equal(rag._extractTimeRatio('::Time'), 0.2);
});
