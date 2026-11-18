'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tray = require('../Plugin/MemoryThinkingTray/MemoryThinkingTray');
const START = '<---VCP记忆思维区Start--->';
const END = '<---VCP记忆思维区End--->';
const block = body => START + body + END;
const input = body => [
    { role: 'system', content: `prefix${block(body)}suffix` },
    { role: 'user', content: 'old query' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'real query' }
];

test('moves body exactly once without modifying sources or unrelated messages', async () => {
    const messages = input('[[测试日记本]]\n[[VCP元思考]]\n[[VCPTimeLine::测试]]');
    Object.defineProperty(messages, '__meta', { value: { request: 1 } });
    const snapshot = JSON.stringify(messages);
    const result = await tray.processMessages(messages);
    assert.equal(result.length, 5);
    assert.equal(result[0].content, 'prefixsuffix');
    assert.equal(result[3].role, 'user');
    assert.equal(result[3].content, '[系统提示:]\n[[测试日记本]]\n[[VCP元思考]]\n[[VCPTimeLine::测试]]');
    assert.strictEqual(result[1], messages[1]);
    assert.strictEqual(result[4], messages[3]);
    assert.strictEqual(result.__meta, messages.__meta);
    assert.equal(JSON.stringify(messages), snapshot);
    assert.strictEqual(await tray.processMessages(result), result);
});

test('depth counts messages from tail, clamps after leading systems and rejects invalid values', async () => {
    for (const [depth, expected] of [[0, 4], [1, 3], [2, 2], [999, 1], [-1, 3], ['bad', 3], ['', 3]]) {
        const result = await tray.processMessages(input('memory'), { MEMORY_THINKING_TRAY_DEPTH: depth });
        assert.equal(result.findIndex(m => m.content === '[系统提示:]\nmemory'), expected);
    }
    const instance = new tray.constructor();
    await instance.initialize({ MEMORY_THINKING_TRAY_DEPTH: 0 });
    assert.equal((await instance.processMessages(input('memory')))[4].content, '[系统提示:]\nmemory');
});

test('does not split native tool result sequences', async () => {
    const messages = [
        input('memory')[0],
        { role: 'user', content: 'query' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
        { role: 'tool', tool_call_id: 'a', content: 'one' },
        { role: 'tool', tool_call_id: 'b', content: 'two' }
    ];
    const result = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_DEPTH: 1 });
    assert.equal(result[2].content, '[系统提示:]\nmemory');
    assert.strictEqual(result[3], messages[2]);
});

test('combines blocks in order and ignores ordinary user, assistant and pseudo-system sources', async () => {
    const messages = [
        { role: 'system', content: block('one') + 'middle' + block('two') },
        { role: 'system', content: { text: 'before' + block('three') + 'after' } },
        { role: 'user', content: block('untrusted') },
        { role: 'assistant', content: block('assistant') },
        { role: 'user', content: '[系统提示:]\n' + block('pseudo') }
    ];
    const result = await tray.processMessages(messages);
    assert.equal(result[0].content, 'middle');
    assert.equal(result[1].content.text, 'beforeafter');
    assert.equal(result[4].content, '[系统提示:]\none\n\ntwo\n\nthree');
    assert.strictEqual(result[2], messages[2]);
    assert.strictEqual(result[5], messages[4]);
});

test('malformed blocks roll back all sources atomically', async () => {
    const warn = console.warn;
    const warnings = [];
    console.warn = text => warnings.push(text);
    try {
        for (const invalid of [START + 'open', END, END + START, START + START + END + END]) {
            const messages = [
                { role: 'system', content: block('valid') },
                { role: 'system', content: invalid }
            ];
            assert.strictEqual(await tray.processMessages(messages), messages);
        }
        assert.equal(warnings.length, 4);
    } finally {
        console.warn = warn;
    }
});

test('preserves multimodal parts and text outside a cross-part tray', async () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const messages = [{
        role: 'system',
        content: [
            { type: 'text', text: 'prefix' + START + 'first' },
            image,
            { type: 'text', text: 'second' + END + 'suffix' }
        ]
    }, { role: 'user', content: 'query' }];
    const snapshot = JSON.stringify(messages);
    const result = await tray.processMessages(messages);
    assert.equal(result[0].content[0].text, 'prefix');
    assert.strictEqual(result[0].content[1], image);
    assert.equal(result[0].content[2].text, 'suffix');
    assert.equal(result[1].content, '[系统提示:]\nfirst\nsecond');
    assert.equal(JSON.stringify(messages), snapshot);
});

test('no markers and empty blocks do not add a pseudo-system message', async () => {
    const messages = [{ role: 'system', content: 'fixed' }];
    assert.strictEqual(await tray.processMessages(messages), messages);
    assert.equal((await tray.processMessages(input(' \n '))).length, 4);
    assert.strictEqual(await tray.processMessages(null), null);
});

test('existing RAG and timeline processors accept the moved carrier and ignore it as a query', async () => {
    const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    const timelineSingleton = require('../Plugin/VCPTimeLine/VCPTimeLine');
    const { findLastRealUserMessage } = require('../modules/messageProcessor');
    const rag = new ragSingleton.constructor();
    const timeline = new timelineSingleton.constructor();
    rag.pushVcpInfo = () => {};
    rag.contextVectorManager.updateContext = async () => {};
    rag.getSingleEmbeddingCached = async text => {
        assert.equal(text, 'real query');
        return [1, 0];
    };
    rag._calculateDynamicParams = async () => ({ k: 3, tagWeight: 0.15, tagTruncationRatio: 0.5, metrics: {} });
    rag.shotgunHistoryEnabled = false;
    rag._processRAGPlaceholder = async () => 'diary result';
    rag.metaThinkingManager.processMetaThinkingChain = async () => 'thinking result';
    timeline.buildQueryContext = async messages => {
        assert.equal(timeline.findLatestRealMessage(messages, 'user'), 'real query');
        return {};
    };
    timeline.buildInjection = async () => 'timeline result';
    const messages = [
        { role: 'system', content: 'fixed' + block('[[测试日记本]]\n[[VCP元思考]]\n[[VCPTimeLine::测试]]') },
        { role: 'user', content: 'real query' }
    ];
    // Depth zero makes the carrier the last user message: both query selectors must skip it.
    const moved = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_DEPTH: 0 });
    assert.equal(findLastRealUserMessage(moved).rawContent, 'real query');
    assert.equal(rag._isRagPlaceholderCarrierUserText(moved[2].content), true);
    const result = await timeline.processMessages(await rag.processMessages(moved, {}));
    assert.equal(result[0].content, 'fixed');
    assert.equal(result[2].content, '[系统提示:]\ndiary result\nthinking result\ntimeline result');
});

test('configured order places the tray immediately before RAG and timeline', () => {
    const order = require('../preprocessor_order.json');
    const index = order.indexOf('MemoryThinkingTray');
    assert(index >= 0);
    assert.deepEqual(order.slice(index, index + 3), ['MemoryThinkingTray', 'RAGDiaryPlugin', 'VCPTimeLine']);
    const manifest = require('../Plugin/MemoryThinkingTray/plugin-manifest.json');
    assert.deepEqual(Object.keys(manifest.configSchema), [
        'MEMORY_THINKING_TRAY_DEPTH', 'MEMORY_THINKING_TRAY_CACHE_BREAKPOINT'
    ]);
    assert.equal(manifest.configSchema.MEMORY_THINKING_TRAY_CACHE_BREAKPOINT.default, false);
});

test('cache breakpoint is opt-in and marks the prefix without mutating input', async () => {
    const messages = input('memory');
    const snapshot = JSON.stringify(messages);
    for (const value of [undefined, false, 'false', 'bad']) {
        const result = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: value });
        assert.strictEqual(result[2], messages[2]);
    }
    for (const value of [true, 'true', 'TRUE']) {
        const result = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: value });
        assert.deepEqual(result[2].content, [{
            type: 'text', text: 'old answer', cache_control: { type: 'ephemeral' }
        }]);
        assert.equal(result[3].content, '[系统提示:]\nmemory');
        assert.strictEqual(result[1], messages[1]);
        assert.strictEqual(result[4], messages[3]);
        assert.strictEqual(await tray.processMessages(result, {
            MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: true
        }), result);
    }
    assert.equal(JSON.stringify(messages), snapshot);
});

test('cache breakpoint preserves multimodal parts and existing cache policy', async () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.com/image.png' } };
    const messages = input('memory');
    messages[2].content = [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'last', custom: 1 },
        image
    ];
    const snapshot = JSON.stringify(messages);
    const result = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: true });
    assert.strictEqual(result[2].content[0], messages[2].content[0]);
    assert.strictEqual(result[2].content[2], image);
    assert.deepEqual(result[2].content[1], {
        type: 'text', text: 'last', custom: 1, cache_control: { type: 'ephemeral' }
    });
    assert.equal(JSON.stringify(messages), snapshot);
    messages[2].content[1].cache_control = { type: 'ephemeral', ttl: '1h' };
    const preserved = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: true });
    assert.strictEqual(preserved[2], messages[2]);
});

test('cache breakpoint follows actual depth and skips unsupported or absent prefix text', async () => {
    const config = { MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: true };
    for (const [depth, expected] of [[0, 3], [1, 2], [2, 1]]) {
        const result = await tray.processMessages(input('memory'), {
            ...config, MEMORY_THINKING_TRAY_DEPTH: depth
        });
        assert.equal(result[expected].content[0].cache_control.type, 'ephemeral');
    }
    const clamped = await tray.processMessages(input('memory'), {
        ...config, MEMORY_THINKING_TRAY_DEPTH: 9999
    });
    assert.equal(clamped[0].content, 'prefixsuffix');
    assert.equal(clamped[2].content, 'old query');
    const messages = input('memory');
    messages[2] = { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] };
    messages.splice(3, 0, { role: 'tool', content: 'result', tool_call_id: 'a' });
    const result = await tray.processMessages(messages, {
        ...config, MEMORY_THINKING_TRAY_DEPTH: 2
    });
    assert.equal(result[1].content[0].cache_control.type, 'ephemeral');
    assert.equal(result[2].content, '[系统提示:]\nmemory');
    assert.strictEqual(result[3], messages[2]);
    assert.strictEqual(result[4], messages[3]);
    messages[2] = { role: 'assistant', content: { text: 'answer', custom: 1 } };
    const objectResult = await tray.processMessages(messages, config);
    assert.deepEqual(objectResult[2].content, {
        text: 'answer', custom: 1, cache_control: { type: 'ephemeral' }
    });
    const noMarkers = [{ role: 'user', content: 'query' }];
    assert.strictEqual(await tray.processMessages(noMarkers, config), noMarkers);
    const empty = await tray.processMessages(input(' \n '), config);
    assert.equal(empty[2].content, 'old answer');
});

test('depth 9999 always stays below all leading system messages', async () => {
    const messages = [
        { role: 'system', content: 'identity' + block('memory') },
        { role: 'system', content: 'fixed rules' },
        { role: 'user', content: 'query' }
    ];
    const result = await tray.processMessages(messages, { MEMORY_THINKING_TRAY_DEPTH: 9999 });
    assert.equal(result[0].role, 'system');
    assert.equal(result[0].content, 'identity');
    assert.strictEqual(result[1], messages[1]);
    assert.equal(result[2].content, '[系统提示:]\nmemory');
    assert.strictEqual(result[3], messages[2]);
});