'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectToolBatchForUpstream } = require('../modules/toolResultBatch');

const call = id => ({ id, type: 'function', function: { name: 'demo', arguments: '{}' } });
const batch = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map(call) });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const image = (url, detail) => ({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } });

test('Chat projects Doubao-style images only after the whole native batch', () => {
    const png = image('data:image/png;base64,iVBORw0KGgo=');
    const remote = image('https://example.com/result.png', 'low');
    const messages = [
        batch('a', 'b'),
        result('a', [{ type: 'text', text: 'generated' }, png, remote]),
        result('b', '{"image_url":"https://example.com/link-only.png"}'),
        { role: 'user', content: 'another instruction' }
    ];
    const body = { model: 'vision', messages };
    const snapshot = structuredClone(body);
    const upstream = projectToolBatchForUpstream(body);

    assert.deepEqual(upstream.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'user']);
    assert.deepEqual(upstream.messages.slice(1, 3).map(message => message.tool_call_id), ['a', 'b']);
    assert.match(upstream.messages[1].content, /^generated\n/);
    assert.equal(upstream.messages[2].content, messages[2].content);
    assert.deepEqual(upstream.messages[3].content.slice(1), [png, remote]);
    assert.match(upstream.messages[3].content[0].text, /"a"/);
    assert.doesNotMatch(JSON.stringify(upstream), /ROLE_DIVIDE|VCP_TOOL_PAYLOAD/);
    assert.deepEqual(body, snapshot);
    assert.deepEqual(projectToolBatchForUpstream(upstream), upstream);
});

test('unmatched or incomplete calls do not create synthetic user input', () => {
    for (const id of ['a', 'unknown']) {
        const messages = [batch('a', 'b'), result(id, [image('https://example.com/result.png')])];
        assert.deepEqual(projectToolBatchForUpstream({ messages }).messages, messages);
    }
});

test('an unsupported image scheme stays out of upstream media and does not erase text', () => {
    const body = { messages: [batch('a'), result('a', [
        { type: 'text', text: 'still here' },
        image('file:///example.png')
    ])] };
    const { messages } = projectToolBatchForUpstream(body);
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /^still here\n/);
    assert.doesNotMatch(messages[1].content, /file:/);
});

test('role divider leaves the native call and result envelopes opaque', () => {
    const divider = require('../modules/roleDivider');
    const literal = '<<<[ROLE_DIVIDE_USER]>>>literal<<<[END_ROLE_DIVIDE_USER]>>>';
    const messages = [
        { ...batch('a'), content: literal },
        result('a', [{ type: 'text', text: literal }, image('https://example.com/result.png')])
    ];
    const divided = divider.process(messages, {
        switches: { user: false, assistant: true, system: true },
        scanSwitches: { user: true, assistant: true, system: true, tool: true }
    });
    assert.deepEqual(divided, messages);
    assert.equal(projectToolBatchForUpstream({ messages: divided }).messages[2].role, 'user');
});