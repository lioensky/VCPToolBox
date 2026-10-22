'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const repositoryRoot = path.resolve(__dirname, '..');
const sourcePath = process.env.TEXT_CHUNKER_PATH || path.join(repositoryRoot, 'TextChunker.js');
const localRequire = createRequire(path.join(repositoryRoot, 'package.json'));
const { get_encoding } = localRequire('@dqbd/tiktoken');
const encoding = get_encoding('cl100k_base');
after(() => encoding.free());

const loadedModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    module: loadedModule,
    exports: loadedModule.exports,
    require: name => name === 'dotenv' ? { config: () => ({ parsed: {} }) } : localRequire(name),
    process: { env: { WhitelistEmbeddingModelMaxToken: '8000' } },
    console: { log() {}, warn() {}, error() {} },
    TextDecoder,
    TextEncoder,
    TypeError,
    Buffer,
    __dirname: path.dirname(sourcePath),
    __filename: sourcePath,
}, { filename: sourcePath });
const { chunkText } = loadedModule.exports;

function assertBoundedChunks(source, chunks, maxTokens, overlapTokens) {
    const originalTokens = encoding.encode(source).length;
    assert.ok(chunks.length > 1, 'fixture must exercise splitting');
    const generousCountLimit = 2 * Math.ceil(originalTokens / (maxTokens - overlapTokens)) + 2;
    assert.ok(chunks.length <= generousCountLimit,
        `expected at most ${generousCountLimit} chunks, got ${chunks.length}; the terminal overlap must not repeat`);
    for (const chunk of chunks) {
        assert.ok(chunk.length > 0, 'all chunks must contain text');
        assert.ok(encoding.encode(chunk).length <= maxTokens,
            `chunk exceeds the requested ${maxTokens}-token limit`);
        assert.ok(!chunk.includes('\uFFFD'), 'token decoding must not introduce replacement characters');
    }
}

// These fixtures contain no literal whitespace, so trimming cannot legitimately
// remove content. Every chunk must extend the covered prefix, with overlap allowed.
function assertCompleteCoverage(source, chunks) {
    let covered = 0;
    for (const chunk of chunks) {
        let position = source.indexOf(chunk);
        let furthestEnd = covered;
        while (position !== -1 && position <= covered) {
            furthestEnd = Math.max(furthestEnd, position + chunk.length);
            position = source.indexOf(chunk, position + 1);
        }
        assert.ok(furthestEnd > covered, 'each chunk must preserve source text and advance coverage without a gap');
        covered = furthestEnd;
    }
    assert.equal(covered, source.length, 'the complete original text, including its tail, must remain covered');
}

test('long ASCII single line keeps source text and terminates after its last chunk', () => {
    const source = Array.from({ length: 60 }, (_, index) => `entry_${index}_abcdefghijklmnopqrstuvwxyz0123456789`).join('|');
    const maxTokens = 64;
    const overlapTokens = 8;
    const chunks = chunkText(source, maxTokens, overlapTokens);
    assertBoundedChunks(source, chunks, maxTokens, overlapTokens);
    assertCompleteCoverage(source, chunks);
});

test('escaped JSON single line does not generate repeated tail fragments or corrupt escapes', () => {
    const source = JSON.stringify({ entries: Array.from({ length: 35 }, (_, index) => ({
        id: index,
        value: `node_${index}\\n\\t\\"escaped\\"\\path\\segment_${index}`,
    })) });
    const maxTokens = 96;
    const overlapTokens = 12;
    const chunks = chunkText(source, maxTokens, overlapTokens);
    assertBoundedChunks(source, chunks, maxTokens, overlapTokens);
    assertCompleteCoverage(source, chunks);
});

test('default budget keeps a long single line bounded without redundant tail chunks', () => {
    const source = 'abcdefghij0123456789'.repeat(2000);
    const maxTokens = 6800;
    const overlapTokens = 680;
    const chunks = chunkText(source);
    assertBoundedChunks(source, chunks, maxTokens, overlapTokens);
    assertCompleteCoverage(source, chunks);
    const originalTokens = encoding.encode(source).length;
    assert.equal(chunks.length, 1 + Math.ceil((originalTokens - maxTokens) / (maxTokens - overlapTokens)));
});

test('zero overlap reconstructs long ASCII text exactly', () => {
    const source = Array.from({ length: 45 }, (_, index) => `record_${index}_abcdef1234567890`).join('|');
    const chunks = chunkText(source, 48, 0);
    assertBoundedChunks(source, chunks, 48, 0);
    assert.equal(chunks.join(''), source);
});

test('word-boundary splitting preserves every non-whitespace character', () => {
    const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';
    const chunks = chunkText(source, 8, 0);
    assertBoundedChunks(source, chunks, 8, 0);
    assert.equal(chunks.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
});

test('Chinese and emoji stay intact at token boundaries with and without overlap', () => {
    const source = Array.from({ length: 25 }, (_, index) => `序号${index}中文边界🙂🚀🌍你好世界`).join('');
    for (const overlapTokens of [0, 6]) {
        const chunks = chunkText(source, 32, overlapTokens);
        assertBoundedChunks(source, chunks, 32, overlapTokens);
        assertCompleteCoverage(source, chunks);
        if (overlapTokens === 0) assert.equal(chunks.join(''), source);
    }
});

test('a token budget too small for one complete emoji fails explicitly', () => {
    assert.ok(encoding.encode('🙂').length > 1, 'fixture must exceed the one-token budget');
    assert.throws(() => chunkText('🙂', 1, 0), { name: 'RangeError' });
});

test('re-tokenizing an isolated slice cannot exceed the requested budget', () => {
    const source = 'alpha beta iota a';
    const chunks = chunkText(source, 2, 0);
    assertBoundedChunks(source, chunks, 2, 0);
    assert.equal(chunks.join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
});

test('sentence overlap leaves enough room for the next sentence', () => {
    const source = 'First short sentence. Another brief sentence. ' + 'longer sentence with many different words filling up the available space.';
    const maxTokens = 15;
    const chunks = chunkText(source, maxTokens, 10);
    assertBoundedChunks(source, chunks, maxTokens, 10);
    assertCompleteCoverage(source.replace(/\s/g, ''), chunks.map(chunk => chunk.replace(/\s/g, '')));
});

test('ordinary short sentences and empty inputs retain their existing behavior', () => {
    const source = '  Hello world.\n你好，世界！🙂  ';
    assert.deepEqual(Array.from(chunkText(source)), [source.trim()]);
    for (const empty of ['', '   ', null, undefined]) {
        assert.deepEqual(Array.from(chunkText(empty)), []);
    }
});
