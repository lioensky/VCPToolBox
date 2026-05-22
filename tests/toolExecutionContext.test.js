const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeExecutionContext } = require('../modules/toolExecutionContext');

test('normalizeExecutionContext trims known context fields', () => {
    assert.deepEqual(normalizeExecutionContext({
        agentAlias: ' Codex ',
        agentId: ' codex-desktop ',
        requestSource: ' chatCompletionHandler '
    }), {
        agentAlias: 'Codex',
        agentId: 'codex-desktop',
        requestSource: 'chatCompletionHandler'
    });
});

test('normalizeExecutionContext preserves current unknown source fallback', () => {
    assert.deepEqual(normalizeExecutionContext({
        agentAlias: '',
        agentId: 42,
        requestSource: '   '
    }), {
        agentAlias: null,
        agentId: null,
        requestSource: 'unknown'
    });
});

test('normalizeExecutionContext can preserve PluginManager null-on-missing behavior', () => {
    assert.equal(normalizeExecutionContext(null, { nullWhenMissing: true }), null);
    assert.equal(normalizeExecutionContext('not-object', { nullWhenMissing: true }), null);
});

test('normalizeExecutionContext returns an object by default for policy checks', () => {
    assert.deepEqual(normalizeExecutionContext(null), {
        agentAlias: null,
        agentId: null,
        requestSource: 'unknown'
    });
});

test('normalizeExecutionContext supports an explicit default requestSource', () => {
    assert.deepEqual(normalizeExecutionContext({}, {
        defaultRequestSource: ' task-scheduler '
    }), {
        agentAlias: null,
        agentId: null,
        requestSource: 'task-scheduler'
    });
});

test('normalizeExecutionContext preserves optional execution metadata when present', () => {
    assert.deepEqual(normalizeExecutionContext({
        agentAlias: ' Codex ',
        agentId: ' codex-desktop ',
        requestSource: ' task-scheduler ',
        operatorId: ' operator-1 ',
        bridgeId: ' bridge-main ',
        taskId: ' task-123 ',
        invocationId: ' invocation-abc '
    }), {
        agentAlias: 'Codex',
        agentId: 'codex-desktop',
        requestSource: 'task-scheduler',
        operatorId: 'operator-1',
        bridgeId: 'bridge-main',
        taskId: 'task-123',
        invocationId: 'invocation-abc'
    });
});

test('normalizeExecutionContext omits blank optional execution metadata', () => {
    const context = normalizeExecutionContext({
        requestSource: 'snowbridge',
        bridgeId: '   ',
        taskId: 42,
        invocationId: null
    });

    assert.equal(Object.prototype.hasOwnProperty.call(context, 'bridgeId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(context, 'taskId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(context, 'invocationId'), false);
});
