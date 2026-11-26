'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withNativeToolDebug } = require('../modules/nativeToolDebug');
const { projectToolBatchForUpstream } = require('../modules/toolResultBatch');

test('FC debug is disabled unless explicitly enabled', () => {
    const body = { model: 'test', messages: [] };
    for (const value of ['', 'false', '0']) {
        assert.equal(withNativeToolDebug(body, value), body);
    }
});

test('FC debug preserves explicit modern and legacy tool settings', () => {
    for (const settings of [
        { tools: [] }, { tools: [{ type: 'function' }] },
        { tool_choice: 'none' }, { tool_choice: 'auto' },
        { functions: [] }, { function_call: 'none' }
    ]) {
        const body = { model: 'test', ...settings };
        assert.equal(withNativeToolDebug(body, 'true'), body);
    }
});

for (const stream of [false, true]) {
    test(`FC debug injects an open vcptools schema on Chat egress; stream=${stream}`, () => {
        const body = { model: 'test', messages: [], stream };
        const debug = withNativeToolDebug(body, 'true');
        const outbound = projectToolBatchForUpstream(debug);
        assert.equal(outbound.tool_choice, 'auto');
        assert.equal(outbound.tools.length, 1);
        assert.equal(outbound.tools[0].type, 'function');
        const fn = outbound.tools[0].function;
        assert.equal(fn.name, 'vcptools');
        assert.equal(fn.strict, false);
        assert.deepEqual(fn.parameters, { type: 'object', additionalProperties: true });
        assert.equal(outbound.stream, stream);
        assert.equal(withNativeToolDebug(debug, 'true'), debug);
        assert.deepEqual(body, { model: 'test', messages: [], stream });
    });
}