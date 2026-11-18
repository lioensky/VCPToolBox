'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHtml, preparePage } = require('../Plugin/UrlFetch/pageExtraction');
const url = 'https://example.org/issues/123';
const prose = 'This is the original issue description, including steps to reproduce and expected behavior. '.repeat(8);

test('SPA shell scripts must not masquerade as body text', () => {
    assert.throws(() => extractHtml(`<html><body>Sign in<app-root></app-root><script>${prose}</script></body></html>`, url), /应用壳/);
});

test('discussion preserves original post, every reply, and sidebar metadata', () => {
    const comments = Array.from({ length: 14 }, (_, i) =>
        `<b-history-event id="comment${i + 2}"><h4>Author ${i + 2}</h4><time>2026-11-14</time><p>Reply sentinel ${i + 2}</p></b-history-event>`).join('');
    const result = extractHtml(`<html><head><title>Bug report</title></head><body><nav>Navigation sentinel</nav><article>
        <b-issue-description>${prose}</b-issue-description>${comments}</article>
        <aside><p>Status: New</p><p>Priority: P2</p></aside></body></html>`, url);
    assert.equal(result.strategy, 'discussion-dom');
    assert.equal(result.entries, 15);
    assert.ok(result.text.includes(prose.trim()));
    for (let i = 2; i <= 15; i++) assert.ok(result.text.includes(`Reply sentinel ${i}`));
    assert.match(result.text, /Status: New/);
    assert.match(result.text, /Priority: P2/);
    assert.doesNotMatch(result.text, /Navigation sentinel/);
});

test('code whitespace and literal markup survive without executing code', () => {
    const raw = 'if (x) {\n    print("中文。代码");\n\n\n    // ```\n}';
    const result = extractHtml(`<body><b-issue-description><p>${prose}</p><pre><code>${raw}</code></pre>
        <p>&lt;tool_call&gt;literal&lt;/tool_call&gt;</p></b-issue-description></body>`, url);
    assert.ok(result.text.includes(raw));
    assert.match(result.text, /<tool_call>literal<\/tool_call>/);
});

test('retain destination URLs and image references but reject executable links', () => {
    const result = extractHtml(`<body><b-issue-description>${prose}<a href="/download?id=3">Attachment</a>
        <img src="/proof.png" alt="Evidence"><a href="javascript:alert(1)">Unsafe</a></b-issue-description></body>`, url);
    assert.match(result.text, /\[Attachment\]\(https:\/\/example.org\/download\?id=3\)/);
    assert.match(result.text, /https:\/\/example.org\/proof.png/);
    assert.doesNotMatch(result.text, /javascript:/);
});

test('semantic content is not removed by broad ads/banner substring selectors', () => {
    const result = extractHtml(`<body><b-issue-description><div class="downloads banner-analysis">${prose}</div>
        <ins>Inserted correction</ins><p hidden>Hidden secret</p><script>Executable secret</script></b-issue-description></body>`, url);
    assert.match(result.text, /Inserted correction/);
    assert.match(result.text, /original issue description/);
    assert.doesNotMatch(result.text, /Hidden secret|Executable secret/);
});

test('ordinary articles still use readable extraction', () => {
    const result = extractHtml(`<html><head><title>Article</title></head><body><article><h1>Article</h1><p>${prose}</p></article></body></html>`, url);
    assert.match(result.text, /original issue description/);
    assert.ok(['readability', 'semantic-dom'].includes(result.strategy));
});

test('preparePage has bounded stabilization and uses independent content readiness', async () => {
    let evaluations = 0;
    let waited = false;
    const page = {
        async waitForFunction(fn, options) {
            waited = true;
            assert.equal(options.timeout, 10000);
            assert.match(fn.toString(), /b-issue-description b-note-container/);
        },
        async evaluate(fn) {
            evaluations++;
            assert.match(fn.toString(), /scrollTop/);
            assert.match(fn.toString(), /cdkscrollable/);
            return 'stable DOM';
        }
    };
    await preparePage(page);
    assert.equal(waited, true);
    assert.equal(evaluations, 3);
});
test('long global navigation does not make an empty app root usable', () => {
    assert.throws(() => extractHtml(`<html><body><header>${prose}</header><app-root></app-root></body></html>`, url), /应用壳/);
});