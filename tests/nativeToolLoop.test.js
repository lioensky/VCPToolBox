'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NATIVE_CALL_ID, normalizeNativeVcpCalls } = require('../modules/nativeToolLoop');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const toolCallRecordStore = require('../modules/toolCallRecordStore');

const makeNativeCall = (id, payload) => ({
    id,
    type: 'function',
    function: {
        name: 'vcptools',
        arguments: JSON.stringify(payload)
    }
});

test('normalizeNativeVcpCalls accepts positive numeric and string vref while rejecting non-positive or blank values', () => {
    const calls = normalizeNativeVcpCalls([
        makeNativeCall('c_num', { tool_name: 'LightMemo', query: 'q', vref: 3 }),
        makeNativeCall('c_float', { tool_name: 'LightMemo', query: 'q', vref: 5.9 }),
        makeNativeCall('c_str', { tool_name: 'LightMemo', query: 'q', vref: ' 4 ' }),
        makeNativeCall('c_jev', { JEV: 'LightMemo:q', vref: 2 }),
        makeNativeCall('c_zero', { tool_name: 'LightMemo', query: 'q', vref: 0 }),
        makeNativeCall('c_neg', { tool_name: 'LightMemo', query: 'q', vref: -3 }),
        makeNativeCall('c_blank', { tool_name: 'LightMemo', query: 'q', vref: '   ' }),
        makeNativeCall('c_bool', { tool_name: 'LightMemo', query: 'q', vref: true })
    ]);

    assert.ok(Array.isArray(calls));
    assert.equal(calls.length, 8);
    assert.equal(calls[0].vref, '3');
    assert.equal(calls[0][NATIVE_CALL_ID], 'c_num');
    assert.equal(calls[1].vref, '5');
    assert.equal(calls[2].vref, '4');
    assert.equal(calls[3].name, 'JEV');
    assert.equal(calls[3].vref, '2');
    assert.equal(calls[4].vref, null);
    assert.equal(calls[5].vref, null);
    assert.equal(calls[6].vref, null);
    assert.equal(calls[7].vref, null);
});

test('numeric vref from native FC resolves vref_files identically to string vref in ToolExecutor', async () => {
    const fakeRag = {
        sanitizeForEmbedding: (s) => s,
        _getEmbeddingFromCacheOnly: () => new Float32Array([1, 0, 0]),
        _getWeightedAverageVector: () => new Float32Array([1, 0, 0]),
        ragParams: { RAGDiaryPlugin: { mainSearchWeights: [0.7, 0.3] } }
    };
    const fakeKb = {
        config: { rootPath: path.resolve(__dirname, '__fake_dailynote__') },
        listDistinctDiaries: async () => ['demo'],
        search: async (_d, _v, n) => Array.from({ length: n }, (_, i) => ({
            fullPath: `demo/note_${i + 1}.txt`,
            score: 0.9 - i * 0.1
        }))
    };

    const origBegin = toolCallRecordStore.beginRecord;
    const origFinish = toolCallRecordStore.finishRecord;
    toolCallRecordStore.beginRecord = () => ({ id: 'tcr-unit-test' });
    toolCallRecordStore.finishRecord = () => {};

    try {
        const received = [];
        const executor = new ToolExecutor({
            pluginManager: {
                messagePreprocessors: new Map([['RAGDiaryPlugin', fakeRag]]),
                vectorDBManager: fakeKb,
                getPlugin: () => ({ name: 'DemoTool' }),
                processToolCall: async (_name, args) => {
                    received.push(args.vref_files);
                    return { ok: true };
                }
            },
            webSocketServer: { broadcast: () => {} },
            debugMode: false,
            vcpToolCode: false
        });

        const calls = normalizeNativeVcpCalls([
            makeNativeCall('v_num', { tool_name: 'DemoTool', vref: 3 }),
            makeNativeCall('v_str', { tool_name: 'DemoTool', vref: '3' }),
            makeNativeCall('v_zero', { tool_name: 'DemoTool', vref: 0 })
        ]);

        const ctx = [{ role: 'user', content: 'native fc vref test' }];
        for (const call of calls) {
            const res = await executor.execute(call, '127.0.0.1', ctx);
            assert.equal(res.success, true);
        }

        assert.equal(received.length, 3);
        assert.equal(received[0].length, 3);
        assert.deepEqual(received[0], received[1]);
        assert.equal(received[2], undefined);
    } finally {
        toolCallRecordStore.beginRecord = origBegin;
        toolCallRecordStore.finishRecord = origFinish;
    }
});

test('numeric tool_password from native FC passes ToolExecutor authentication and strips credential from plugin args', async () => {
    const origBegin = toolCallRecordStore.beginRecord;
    const origFinish = toolCallRecordStore.finishRecord;
    toolCallRecordStore.beginRecord = () => ({ id: 'tcr-auth-test' });
    toolCallRecordStore.finishRecord = () => {};

    try {
        let seenArgs = null;
        const executor = new ToolExecutor({
            pluginManager: {
                getPlugin: () => ({ name: 'DemoTool' }),
                processToolCall: async (_name, args) => {
                    seenArgs = { ...args };
                    return { ok: true };
                }
            },
            webSocketServer: { broadcast: () => {} },
            debugMode: false,
            vcpToolCode: true,
            getRealAuthCode: async () => '123456'
        });

        const [okNumCall, badNumCall] = normalizeNativeVcpCalls([
            makeNativeCall('auth_ok', { tool_name: 'DemoTool', action: 'run', tool_password: 123456 }),
            makeNativeCall('auth_bad', { tool_name: 'DemoTool', action: 'run', tool_password: 999999 })
        ]);

        assert.equal(okNumCall.args.tool_password, '123456');

        const okRes = await executor.execute(okNumCall, '127.0.0.1', []);
        assert.equal(okRes.success, true);
        assert.equal(Object.hasOwn(seenArgs, 'tool_password'), false);

        const badRes = await executor.execute(badNumCall, '127.0.0.1', []);
        assert.equal(badRes.success, false);
        assert.match(badRes.error, /tool_password 验证失败/);
    } finally {
        toolCallRecordStore.beginRecord = origBegin;
        toolCallRecordStore.finishRecord = origFinish;
    }
});
