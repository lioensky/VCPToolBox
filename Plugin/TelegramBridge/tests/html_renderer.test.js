'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTelegramSegments,
  escapeTelegramHtml,
  renderTelegramHtml,
} = require('../src/streamRenderer');

test('controlled HTML renderer escapes raw markup and permits only supported formatting', () => {
  const input = '<b>raw</b> **bold** *italic* `a<b` [safe](https://example.com/a?x=1&y=2)';
  const html = renderTelegramHtml(input);
  assert.equal(
    html,
    '&lt;b&gt;raw&lt;/b&gt; <b>bold</b> <i>italic</i> <code>a&lt;b</code> '
      + '<a href="https://example.com/a?x=1&amp;y=2">safe</a>',
  );
  assert.equal(html.includes('<b>raw</b>'), false);
  assert.equal(escapeTelegramHtml('a&<b>"'), 'a&amp;&lt;b&gt;&quot;');
});

test('dangerous or credentialed links are rendered as escaped labels without hrefs', () => {
  const html = renderTelegramHtml([
    '[js](javascript:alert(1))',
    '[file](file:///etc/passwd)',
    '[data](data:text/html,secret)',
    '[creds](https://user:pass@example.com/private)',
    '[ok](https://example.com/path)',
  ].join(' '));
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('file:'), false);
  assert.equal(html.includes('data:'), false);
  assert.equal(html.includes('user:pass'), false);
  assert.match(html, /js file data creds <a href="https:\/\/example\.com\/path">ok<\/a>/);
});

test('code blocks and inline code escape contents and never accept model HTML', () => {
  const input = '```js\nif (a < b) x &= 1;\n```\n`<tag>`';
  assert.equal(
    renderTelegramHtml(input),
    '<pre><code class="language-js">if (a &lt; b) x &amp;= 1;\n</code></pre>\n'
      + '<code>&lt;tag&gt;</code>',
  );
});

test('short answers keep controlled HTML while long answers fall back to grapheme-safe plain chunks', () => {
  assert.deepEqual(buildTelegramSegments('**short**', { maxChars: 20 }), [{
    text: '<b>short</b>',
    plainText: '**short**',
    parseMode: 'HTML',
  }]);

  const family = '👨‍👩‍👧‍👦';
  const text = `${family}${family}${family} abcdefghijklmnopqrstuvwxyz`;
  const chunks = buildTelegramSegments(text, { maxChars: 12 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.parseMode === null), true);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
  assert.equal(chunks.every((chunk) => chunk.text.length <= 12), true);
  assert.equal(chunks.some((chunk) => chunk.text.includes('\u200d') && !chunk.text.includes(family)), false);
});

test('invalid renderer inputs fail without accepting arbitrary objects', () => {
  assert.throws(() => renderTelegramHtml({ toString: () => '<b>bad</b>' }));
  assert.throws(() => buildTelegramSegments('text', { maxChars: 0 }));
});
