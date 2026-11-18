'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    guardMarkdownDataImagesInText,
    guardMarkdownDataImagesForUpstream
} = require('../modules/markdownDataImageGuard');
const { projectToolBatchForUpstream } = require('../modules/toolResultBatch');

const PIXEL_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const REAL_PNG = `data:image/png;base64,iVBORw0KGgoA${'A'.repeat(4000)}`;
const REAL_JPEG = `data:image/jpeg;base64,/9j/${'A'.repeat(4000)}`;

/**
 * 网关侧扫描逻辑的等价实现：返回 'ok'、'decode-error' 或被当作图片发出的 MIME 列表。
 */
function gatewayScan(text) {
    const mimes = [];
    for (;;) {
        const start = text.indexOf('![');
        if (start === -1) break;
        let bracket = text.slice(start).indexOf('](data:');
        if (bracket === -1) break;
        bracket += start;
        let close = text.slice(bracket + 2).indexOf(')');
        if (close === -1) break;
        close += bracket + 2;
        const url = text.slice(bracket + 2, close);
        const comma = url.indexOf(',');
        const prefix = comma === -1 ? '' : url.slice(0, comma);
        if (comma === -1 || !prefix.includes(';')) return 'decode-error';
        mimes.push(prefix.slice(prefix.indexOf(':') + 1, prefix.indexOf(';')));
        text = text.slice(close + 1);
    }
    return mimes.length ? mimes : 'ok';
}

test('placeholder pixel from scraped pages is degraded and the surrounding text survives', () => {
    const input = `[Infographic] A ![chart](${PIXEL_GIF}) B 后面的正文`;
    assert.deepEqual(gatewayScan(input), ['image/gif']);
    const output = guardMarkdownDataImagesInText(input);
    assert.equal(output, '[Infographic] A [图片: chart] B 后面的正文');
    assert.equal(gatewayScan(output), 'ok');
});

test('data URLs the gateway cannot decode are neutralized', () => {
    for (const input of [
        '网关会把 ![...](data:image/gif...) 转成图片',
        '![a](data:image/png;base64,iVBO…)',
        '![a](data:image/svg+xml;utf8,<svg/>)',
        '![](data:image/png;base64)',
        '前文 ![说明\n跨行](data:image/png;base64 后文没有闭合也有 ) 括号'
    ]) {
        assert.notEqual(gatewayScan(input), 'ok', input);
        assert.equal(gatewayScan(guardMarkdownDataImagesInText(input)), 'ok', input);
    }
    assert.equal(guardMarkdownDataImagesInText('![](data:image/png;base64)'), '[图片]');
});

test('unsupported formats and tiny images are degraded even when the base64 is valid', () => {
    const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = `data:image/svg+xml;base64,${'A'.repeat(4000)}`;
    assert.equal(guardMarkdownDataImagesInText(`![t](${tinyPng})`), '[图片: t]');
    assert.equal(guardMarkdownDataImagesInText(`![s](${svg})`), '[图片: s]');
});

test('real inline images are kept byte-for-byte', () => {
    for (const url of [REAL_PNG, REAL_JPEG]) {
        const input = `看这张 ![image](${url}) 再改一下`;
        assert.equal(guardMarkdownDataImagesInText(input), input);
    }
    const mixed = `![x](${PIXEL_GIF}) 和 ![image](${REAL_PNG})`;
    assert.equal(guardMarkdownDataImagesInText(mixed), `[图片: x] 和 ![image](${REAL_PNG})`);
});

test('ordinary content is untouched', () => {
    for (const input of [
        '<img src="http://localhost:6005/pw=x/images/通用表情包/开心.png" width="60">',
        '![cat](https://example.com/a.gif)',
        `<img src="${PIXEL_GIF}">`,
        'CSS: background: url(data:image/gif;base64,R0lGOD)',
        '没有任何图片的普通文本'
    ]) {
        assert.equal(guardMarkdownDataImagesInText(input), input);
    }
});

test('request projection only rewrites text and keeps untouched objects by reference', () => {
    const imagePart = { type: 'image_url', image_url: { url: PIXEL_GIF } };
    const clean = { role: 'user', content: [{ type: 'text', text: 'hi' }, imagePart] };
    const dirtyString = { role: 'user', content: `x ![p](${PIXEL_GIF}) y` };
    const dirtyParts = { role: 'user', content: [{ type: 'text', text: `![p](${PIXEL_GIF})` }, imagePart] };
    const toolCall = { role: 'assistant', content: null, tool_calls: [{ function: { arguments: `![p](${PIXEL_GIF})` } }] };
    const body = { model: 'm', messages: [clean, dirtyString, dirtyParts, toolCall] };
    const snapshot = JSON.stringify(body);

    const output = guardMarkdownDataImagesForUpstream(body);
    assert.equal(JSON.stringify(body), snapshot, 'input is not mutated');
    assert.equal(output.messages[0], clean);
    assert.equal(output.messages[1].content, 'x [图片: p] y');
    assert.equal(output.messages[2].content[0].text, '[图片: p]');
    assert.equal(output.messages[2].content[1], imagePart);
    assert.equal(output.messages[3], toolCall);

    const cleanBody = { messages: [clean] };
    assert.equal(guardMarkdownDataImagesForUpstream(cleanBody), cleanBody);
});

test('the shared upstream projection applies the guard and honours the switch', () => {
    const body = { messages: [{ role: 'user', content: `![p](${PIXEL_GIF})` }] };
    assert.equal(projectToolBatchForUpstream(body).messages[0].content, '[图片: p]');

    process.env.EnableMarkdownDataImageGuard = 'false';
    try {
        assert.equal(projectToolBatchForUpstream(body).messages[0].content, `![p](${PIXEL_GIF})`);
    } finally {
        delete process.env.EnableMarkdownDataImageGuard;
    }
});
