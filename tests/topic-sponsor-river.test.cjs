'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ToolExecutor = require('../modules/vcpLoop/toolExecutor');
const records = require('../modules/toolCallRecordStore');

test('TopicSponsor river stays recent, text-only and opt-in at both audit and RPC entry', async t => {
    const audited = [];
    const sent = [];
    t.mock.method(records, 'beginRecord', ({ args }) => (audited.push(structuredClone(args)), {}));
    t.mock.method(records, 'finishRecord', () => {});
    const executor = new ToolExecutor({
        webSocketServer: { broadcast() {} },
        pluginManager: {
            getPlugin: () => ({}),
            processToolCall: async (name, args) => {
                sent.push(structuredClone(args));
                return { success: true, content: [] };
            },
        },
    });
    const messages = Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `turn ${index}` }));
    const path = String.raw`file://H:\attachments\pic.png`;
    messages[7] = {
        role: 'user',
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
    assert.equal(quote.length, 5);
    assert.equal(quote[0].content, 'turn 3');
    assert.deepEqual(quote.at(-1), { role: 'user', content: `[附加图片: ${path}] ` });
    assert.equal((await run('last:2')).length, 2);
    assert.equal((await run('text')).length, 5);
    assert.equal(await run(null), undefined);
    assert.deepEqual(await run('full', 'OtherPlugin'), messages);
});