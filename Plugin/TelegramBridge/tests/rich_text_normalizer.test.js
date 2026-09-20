'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeVcpRichText, readMediaCandidateSource } = require('../src/richTextNormalizer');

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'vcpchat-rich-example-agent.html.txt'),
  'utf8',
);

test('download links expose sources only through the candidate WeakMap', () => {
  for (const [url, sourceKind] of [
    ['file:///C:/outputs/report.pdf', 'file-local'],
    ['http://localhost:6005/pw=private-fixture/files/report.pdf', 'vcp-file'],
    ['https://cdn.example.com/report.pdf?signature=private-fixture', 'https'],
  ]) {
    const result = normalizeVcpRichText(`[download](${url})`);
    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].kind, 'file');
    assert.equal(result.media[0].sourceKind, sourceKind);
    assert.equal(readMediaCandidateSource(result.media[0]), url);
    assert.equal(readMediaCandidateSource({ ...result.media[0] }), null);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture|file:|https?:|report\.pdf/);
  }
});

test('all incomplete download destinations and URL labels stay private', () => {
  for (const markup of [
    '[download](file:///C:/outputs/private-fixture.pdf)',
    '[download](http://localhost:6005/pw=private-fixture/files/a.pdf)',
    '[download](https://cdn.example.com/a.pdf?key=private-fixture)',
    '[file:///C:/private-fixture.pdf](file:///C:/outputs/a.pdf)',
  ]) {
    for (let end = 1; end <= markup.length; end++) {
      const result = normalizeVcpRichText('before ' + markup.slice(0, end));
      assert.doesNotMatch(JSON.stringify(result), /file:|https?:|localhost|private-fixture|pw=/);
    }
  }
});

test('HTML downloads, nested labels and angle-wrapped paths yield file candidates', () => {
  for (const input of [
    '[a [report]](<file:///C:/outputs/a%20b.pdf>) after',
    '<a href="file:///C:/outputs/a.pdf">download</a> after',
    '<a href="http://localhost:6005/pw=private-fixture/files/a.pdf">private-fixture URL: file:///x</a> after',
  ]) {
    const result = normalizeVcpRichText(input);
    assert.equal(result.media[0]?.kind, 'file');
    assert.match(result.text, /after$/);
    assert.doesNotMatch(JSON.stringify(result), /file:|https?:|private-fixture/);
  }
  assert.equal(normalizeVcpRichText('`[download](file:///a.pdf)`').media.length, 0);
  assert.equal(normalizeVcpRichText('[docs](https://example.com/docs)').text, '[docs](https://example.com/docs)');
});

test('quoted and escaped resource examples never upload or reveal private destinations', () => {
  const url = 'http://localhost:6005/pw=private-fixture/files/a.pdf';
  for (const input of [
    '`[download](' + url + ')`',
    '~~~md\n[download](file:///C:/private-fixture.pdf)\n~~~',
    '\\[download](' + url + ')',
    '\\![image](https://cdn.example/a.png?signature=private-fixture)',
    '```html\n<img src="' + url + '">\n```',
  ]) {
    const result = normalizeVcpRichText(input);
    assert.equal(result.media.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture|file:|https?:|localhost/);
  }
});

test('HTML and Markdown share decoded URL confidentiality, including encoded query names', () => {
  for (const url of [
    'https://cdn.example/pw=fixture-secret/images/a.png',
    'https://cdn.example/%2570w%253Dfixture-secret/images/a.png',
    'https://cdn.example/view?%74oken=fixture-secret',
    'https://cdn.example/view?%2574oken=fixture-secret',
    'https://cdn.example/view?api_key=fixture-secret',
    'https://cdn.example/view?x=1&amp;%74oken=fixture-secret',
    'https://user:fixture-secret@cdn.example/view',
  ]) {
    for (const input of [`[view](${url})`, `<a href="${url}">view</a>`, '`[view](' + url + ')`']) {
      const result = normalizeVcpRichText(input);
      assert.doesNotMatch(JSON.stringify(result), /https?:|cdn\.example|fixture-secret/);
      assert.match(result.text, /view|文件|资源/);
    }
  }
});

test('Markdown image syntax creates media for the real relative-image shape', () => {
  const result = normalizeVcpRichText('正文\n![ExampleAgent贴贴](ExampleAgent表情包/meme-fixture.png)\n结束');
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].sourceKind, 'vcp-relative');
  assert.match(result.text, /ExampleAgent贴贴/);
  assert.doesNotMatch(result.text, /!\[|meme-fixture|ExampleAgent表情包/);
});

test('nested labels, multiline labels and URL-valued alt never expose private addresses', () => {
  const url = 'http://localhost:6005/pw=fixture-private/images/a.png';
  for (const input of [
    `![one [two]](${url})`, `![one\ntwo](${url})`, `![${url}](ExampleAgent/a.png)`,
    `<img src="${url}" alt="${url}">`,
    '![http&#58;//localhost:6005/pw&#61;fixture-private/images/a.png](ExampleAgent/a.png)',
  ]) {
    const result = normalizeVcpRichText(input);
    assert.equal(result.media.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /localhost|fixture-private/);
    assert.doesNotMatch(result.media[0].alt, /[\r\n]/);
  }
});

test('apostrophe filenames preserve following prose and tilde fences or escapes never upload', () => {
  const result = normalizeVcpRichText("before ![pic](ExampleAgent/it's.png) after");
  assert.equal(result.media.length, 1);
  assert.match(result.text, /after$/);
  for (const text of ['~~~md\n![pic](ExampleAgent/a.png)\n~~~', '\\![pic](ExampleAgent/a.png)']) {
    assert.equal(normalizeVcpRichText(text).media.length, 0);
  }
  assert.equal(normalizeVcpRichText('~~~md\n~~~\n![pic](ExampleAgent/a.png)').media.length, 1);
  assert.equal(normalizeVcpRichText('~~~md\n~~~<img src="ExampleAgent/a.png">').media.length, 0);
});

test('Markdown VCP URLs stay out of previews/history, including every incomplete prefix', () => {
  const markup = '![image](http://localhost:6005/pw=fixture-private/images/ExampleAgent/a(1).png)';
  for (let i = 2; i <= markup.length; i++) {
    const result = normalizeVcpRichText('正文\n' + markup.slice(0, i));
    assert.doesNotMatch(result.text, /localhost|fixture-private|pw=/);
  }
  const result = normalizeVcpRichText(markup);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].sourceKind, 'vcp-local');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
});

test('code and blocked containers cannot trigger media and invalid images show a clear placeholder', () => {
  const md = '![image](ExampleAgent/a.png)';
  assert.equal(normalizeVcpRichText('`' + md + '`').media.length, 0);
  assert.equal(normalizeVcpRichText('<script>' + md + '</script>').media.length, 0);
  for (const target of ['../config.env', '%2e%2e/a.png', 'file:///etc/passwd', '//host/a.png', 'data:image/png,abc']) {
    const result = normalizeVcpRichText('正文 ![图](' + target + ')');
    assert.equal(result.media.length, 0);
    assert.match(result.text, /图片不可用/);
    assert.doesNotMatch(result.text, /config.env|passwd|data:image/);
  }
});

test('normalizes the real VCPChat rich reply without losing visible prose', () => {
  const result = normalizeVcpRichText(fixture);

  assert.equal(result.text.includes('<div'), false);
  assert.equal(result.text.includes('style='), false);
  assert.equal(result.text.includes('[@'), false);
  assert.match(result.text, /ExampleAgent/);
  assert.match(result.text, /• 条目一/);
  assert.equal(result.media.length, 1);
  assert.equal(JSON.stringify(result).includes('pw=fixture'), false);
});

test('tokenizes quoted tag terminators and preserves supported document semantics', () => {
  const input = [
    '<h2 data-label="1 > 0">标题</h2>',
    '<p><strong>粗体</strong>和<em>斜体</em>，<a href="https://example.com/a?x=1%3E0">链接</a></p>',
    '<ol><li>第一项</li><li>第二项</li></ol>',
    '<blockquote>引用</blockquote>',
  ].join('');

  const result = normalizeVcpRichText(input);

  assert.match(result.text, /标题/);
  assert.match(result.text, /\*\*粗体\*\*/);
  assert.match(result.text, /\*斜体\*/);
  assert.match(result.text, /\[链接\]\(https:\/\/example\.com\/a\?x=1%3E0\)/);
  assert.match(result.text, /1\. 第一项/);
  assert.match(result.text, /2\. 第二项/);
  assert.match(result.text, /^> 引用$/m);
  assert.equal(result.text.includes('data-label'), false);
});

test('drops comments and executable containers with all of their content', () => {
  const input = [
    '开始<!-- secret -->',
    '<script>alert(1)</script>',
    '<style>.secret{display:block}</style>',
    '<iframe><p>frame secret</p></iframe>',
    '<svg><text>svg secret</text></svg>',
    '<p>结束</p>',
  ].join('');

  const result = normalizeVcpRichText(input);

  assert.equal(result.text, '开始\n\n结束');
  assert.doesNotMatch(result.text, /secret|alert|frame|svg/i);
});

test('preserves HTML-looking code while dropping executable containers', () => {
  const input = '```html\n<div>demo</div>\n```\n<script>alert(1)</script><p>正文</p>';
  const result = normalizeVcpRichText(input);

  assert.match(result.text, /```html\n<div>demo<\/div>\n```/);
  assert.doesNotMatch(result.text, /alert/);
  assert.match(result.text, /正文/);
});

test('restores fenced and inline code with their original whitespace intact', () => {
  const input = '`a\t  b`\n```js\n  const x = 1;\n\treturn  x;\n```';

  assert.equal(normalizeVcpRichText(input).text, input);
});

test('strips a quoted pre-code wrapper without exposing its attributes', () => {
  const result = normalizeVcpRichText(
    '<pre><code data-label="1 > 0" data-secret="pw=fixture-secret">visible</code></pre>',
  );

  assert.equal(result.text, '```\nvisible\n```');
  assert.equal(result.text.includes('pw=fixture-secret'), false);
  assert.equal(result.text.includes('data-label'), false);
});

test('bounds malformed tags and entities while removing invisible controls', () => {
  const longEntity = `&${'a'.repeat(200)};`;
  const input = `前文<broken attr="unterminated ${longEntity}\u202E后文\u0000`;

  const result = normalizeVcpRichText(input, { maxTagLength: 64, maxEntityLength: 32 });

  assert.match(result.text, /前文/);
  assert.equal(result.text.includes('\u202E'), false);
  assert.equal(result.text.includes('\u0000'), false);
  assert.equal(result.text.includes('<broken'), false);
  assert.equal(result.text.includes('attr='), false);
});

test('hides an incomplete trailing tag from streaming previews', () => {
  const result = normalizeVcpRichText('已确认正文<div style="color:red');

  assert.equal(result.text, '已确认正文');
  assert.equal(result.detectedRichText, true);
});

test('removes only bounded trailing VCP tags and preserves ordinary bracket text', () => {
  const input = '正文中的 [@普通文本] 不删除，`[@代码]` 也保留。\n[@!tail-one] [@tail-two]';
  const result = normalizeVcpRichText(input);

  assert.match(result.text, /\[@普通文本\]/);
  assert.match(result.text, /`\[@代码\]`/);
  assert.doesNotMatch(result.text, /tail-one|tail-two/);
});

test('preserves an ordinary final-line mention while removing a dedicated internal tag line', () => {
  assert.equal(normalizeVcpRichText('请联系 [@alice]').text, '请联系 [@alice]');
  assert.equal(
    normalizeVcpRichText('正文\n[@!internal] [@second]').text,
    '正文',
  );
});

test('entity decoding cannot recreate controls or forge protected markdown tokens', () => {
  const result = normalizeVcpRichText(
    '```html\n<div>safe</div>\n```&#xE100;0&#xE101;&#x202E;&#0;尾',
  );

  assert.equal(result.text.match(/<div>safe<\/div>/g)?.length, 1);
  assert.equal(/[\u0000\u202E\uE000-\uF8FF]/.test(result.text), false);
  assert.match(result.text, /尾$/);
});

test('keeps safe HTTP links and quotes every line of a multiline blockquote', () => {
  const result = normalizeVcpRichText(
    '<p><a href="http://example.com/docs">文档</a></p><blockquote>第一行<br>第二行</blockquote>',
  );

  assert.match(result.text, /\[文档\]\(http:\/\/example\.com\/docs\)/);
  assert.match(result.text, /^> 第一行$/m);
  assert.match(result.text, /^> 第二行$/m);
});

test('enforces an independent normalized output byte limit', () => {
  assert.throws(
    () => normalizeVcpRichText('<ul><li>x</li></ul>', { maxOutputBytes: 3 }),
    (error) => error?.code === 'RICH_TEXT_OUTPUT_TOO_LARGE',
  );
});

test('rejects unsafe image and link URLs without disclosing their values', () => {
  const input = [
    '<a href="javascript:alert(1)">危险链接</a>',
    '<img src="data:image/png;base64,secret" alt="危险图片">',
    '<img src="http://localhost:6005/pw=fixture/images/ExampleAgent/a.png" alt="本地图片">',
    '<img src="https://cdn.example.com/safe.png" alt="远程图片">',
  ].join('');

  const result = normalizeVcpRichText(input);

  assert.match(result.text, /危险链接/);
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.media.map((item) => item.sourceKind), ['vcp-local', 'https']);
  assert.equal(JSON.stringify(result).includes('javascript:'), false);
  assert.equal(JSON.stringify(result).includes('data:image'), false);
  assert.equal(JSON.stringify(result).includes('pw=fixture'), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.media), true);
  assert.equal(result.media.every(Object.isFrozen), true);
});

test('enforces document and tokenizer bounds with stable sanitized errors', () => {
  assert.throws(
    () => normalizeVcpRichText('12345', { maxBytes: 4 }),
    (error) => error?.code === 'RICH_TEXT_TOO_LARGE'
      && error.message === 'VCP rich text normalization failed.'
      && !error.message.includes('12345'),
  );
  assert.throws(
    () => normalizeVcpRichText('<b>x</b>', { maxTags: 1 }),
    (error) => error?.code === 'RICH_TEXT_TAG_LIMIT',
  );
});
