'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const records = require('../modules/toolCallRecordStore');
const jevRiverReranker = require('../modules/jevRiverReranker');

test('TopicSponsor river stays recent, text-only and opt-in at both audit and RPC entry', async t => {
    const audited = [];
    const sent = [];
    t.mock.method(records, 'beginRecord', ({ args }) => (audited.push(structuredClone(args)), {}));
    t.mock.method(records, 'finishRecord', () => {});
    t.mock.method(jevRiverReranker, 'isEnabled', () => false);
    const executor = new ToolExecutor({
        webSocketServer: { broadcast() {} },
        pluginManager: {
            messagePreprocessors: new Map([['RAGDiaryPlugin', {
                sanitizeForEmbedding: text => text,
                getSingleEmbeddingCached: async () => [1, 0],
            }]]),
            getPlugin: () => ({}),
            processToolCall: async (name, args) => {
                sent.push(structuredClone(args));
                return { success: true, content: [] };
            },
        },
    });
    const messages = Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
    const path = String.raw`file://H:\attachments\pic.png`;
    messages[4] = { role: 'user', name: '莱恩', content: 'human context sentence' };
    messages[5] = { role: 'system', name: '不应转发', content: 'internal' };
    messages[6] = { role: 'assistant', name: 'Nova', content: 'assistant context sentence' };
    messages[7] = {
        role: 'user',
        name: '莱恩',
        content: [
            { type: 'text', text: `[附加图片: ${path}] data:image/png;base64,AAAA` },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        ],
        attachmentBase64: 'CCCC',
    };
    async function run(river, name = 'TopicSponsor') {
        const result = await executor.execute({ name, args: { command: 'ReplyToTopic', river_context: 'untrusted' }, river }, null, messages);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(audited.at(-1), sent.at(-1));
        return sent.at(-1).river_context;
    }
    const quote = await run('full');
    assert.equal(quote.length, 4);
    assert.equal(quote[0].content, 'turn 3');
    assert.deepEqual(quote.map(row => row.name), [undefined, '莱恩', 'Nova', '莱恩']);
    assert.deepEqual(quote.at(-1), { role: 'user', name: '莱恩', content: `[附加图片: ${path}] ` });
    assert.deepEqual((await run('last:2')).map(row => row.name), ['Nova', '莱恩']);
    assert.equal((await run('text')).length, 4);
    assert.equal(await run(null), undefined);
    assert.deepEqual(await run('full', 'OtherPlugin'), messages);
    for (const river of ['text', 'last:2', 'semantic:9']) {
        const rows = await run(river, 'OtherPlugin');
        assert.deepEqual(rows.slice(-2).map(row => row.name), ['Nova', '莱恩']);
        if (river.startsWith('semantic:')) {
            assert.deepEqual(rows.map(row => row._river_index), [4, 6, 7]);
        }
    }
});