'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { preprocessPageInfo } = require('../Plugin/ChromeBridge/pageInfoPreprocessor');
const P = '{{VCPChromePageInfo}}';

test('only system and pseudo-system user trigger; one snapshot, one injection', async () => {
    const messages = [
        { role: 'assistant', content: P },
        { role: 'user', content: P },
        { role: 'system', content: `${P} ${P}` },
        { role: 'user', content: `[系统提示:] ${P}` }
    ];
    let calls = 0;
    const result = await preprocessPageInfo(messages, async () => { calls++; return 'PAGE'; });
    assert.equal(result, messages);
    assert.equal(calls, 1);
    assert.equal(messages[0].content, P);
    assert.equal(messages[1].content, P);
    assert.equal(messages[2].content, 'PAGE ');
    assert.equal(messages[3].content, '[系统提示:] ');
});

test('ordinary user and tool messages do not fetch', async () => {
    await preprocessPageInfo([
        { role: 'user', content: `quoted [系统提示:] ${P}` },
        { role: 'tool', content: P }
    ], () => { throw new Error('must not fetch'); });
});

test('text parts are supported and page triggers cannot recurse', async () => {
    let calls = 0;
    const messages = [{ role: 'user', content: [
        { type: 'text', text: '[系统通知]\n' },
        { type: 'image_url', image_url: { url: 'test' } },
        { type: 'text', text: P }
    ] }];
    const fetch = async () => { calls++; return `page ${P} $&`; };
    await preprocessPageInfo(messages, fetch);
    await preprocessPageInfo(messages, fetch);
    assert.equal(calls, 1);
    assert.equal(messages[0].content[2].text, 'page VCPChromePageInfo $&');
});

test('failure consumes all triggers once without cached content', async () => {
    const messages = [{ role: 'system', content: `${P}${P}` }];
    await preprocessPageInfo(messages, async () => { throw new Error('offline'); });
    assert.equal(messages[0].content, '[ChromeBridge 页面采样失败：offline]');
});

test('parallel requests do not share page content', async () => {
    const a = [{ role: 'system', content: P }];
    const b = [{ role: 'system', content: P }];
    await Promise.all([
        preprocessPageInfo(a, async () => { await new Promise(r => setTimeout(r, 10)); return 'A'; }),
        preprocessPageInfo(b, async () => 'B')
    ]);
    assert.equal(a[0].content, 'A');
    assert.equal(b[0].content, 'B');
});