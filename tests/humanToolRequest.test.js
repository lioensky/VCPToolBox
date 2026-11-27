'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHumanToolRequest } = require('../modules/humanToolRequest.js');

const functionCall = (name, args) => ({
    id: 'call_123',
    type: 'function',
    function: { name, arguments: args }
});

test('legacy VCP plain text still uses the existing parser', () => {
    const text = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Demo「末」,',
        'command:「始」List「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    assert.deepEqual(normalizeHumanToolRequest(text, false), {
        name: 'Demo', args: { command: 'List' }
    });
    assert.match(normalizeHumanToolRequest(text, true).error, /JSON function call object/);
});

test('accepts a Chat Completions call without converting JSON arguments to strings', () => {
    const args = { ids: [1, 2], enabled: false, count: 0, labels: { note: '「始」「末」' }, value: null };
    const call = functionCall('Demo', JSON.stringify(args));
    for (const body of [call, { role: 'assistant', tool_calls: [call] }, functionCall('Demo', args)]) {
        assert.deepEqual(normalizeHumanToolRequest(body, true), { name: 'Demo', args });
    }
});

test('accepts flat harness and Responses function calls', () => {
    for (const metadata of [{}, { type: 'function_call', call_id: 'call_123' }]) {
        assert.deepEqual(normalizeHumanToolRequest({
            ...metadata, name: 'Demo', arguments: {}
        }, true), { name: 'Demo', args: {} });
    }
});

test('unwraps vcptools using its explicit target, without applying chat-loop directives', () => {
    assert.deepEqual(normalizeHumanToolRequest(functionCall('vcptools', {
        tool_name: 'Demo', command: 'List', archery: true
    }), true), { name: 'Demo', args: { command: 'List', archery: true } });
    assert.match(normalizeHumanToolRequest(functionCall('vcptools', {}), true).error, /tool_name/);
    assert.match(normalizeHumanToolRequest(functionCall('Demo', { tool_name: 'Other' }), true).error, /conflicts/);
});

test('rejects malformed, ambiguous and batched inputs', () => {
    const call = functionCall('Demo', {});
    const invalid = [
        null, [call], {}, { tool_calls: [] }, { tool_calls: [null] },
        { tool_calls: [call, call] }, { ...call, tool_calls: [call] },
        { ...call, name: 'Other' }, { ...call, type: 'custom' },
        functionCall('', {}), functionCall('Demo', '{'), functionCall('Demo', undefined),
        functionCall('Demo', 'null'), functionCall('Demo', '[]'), functionCall('Demo', 42)
    ];
    for (const body of invalid) {
        const result = normalizeHumanToolRequest(body, true);
        assert.equal(typeof result.error, 'string');
        assert.equal(result.name, undefined);
    }
    assert.match(normalizeHumanToolRequest(call, false).error, /application\/json/);
    assert.match(normalizeHumanToolRequest('invalid', false).error, /TOOL_REQUEST markers/);
});