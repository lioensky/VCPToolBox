'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WhitelistEmbeddingModelMaxToken = '8000';
process.env.EMBEDDING_MAX_BATCH_ITEMS = '32';
const { chunkText, getTokenCount } = require('../TextChunker');
const { getEmbeddingsBatch } = require('../EmbeddingUtils');
const manager = require('../KnowledgeBaseManager');
const { NativeKnowledgeRuntime, VexusIndex } = require('../rust-vexus-lite');

function embed(chunks, requests) {
    let sent = 0;
    return getEmbeddingsBatch(chunks, {
        apiUrl: 'http://127.0.0.1:65530', apiKey: 'test-key', model: 'test-embedding', concurrency: 1,
        fetchImpl: async (_url, request) => {
            const { input } = JSON.parse(request.body);
            requests.push(input);
            return { ok: true, text: async () => JSON.stringify({
                data: input.map((_, index) => ({ index, embedding: [++sent, 0] }))
            }) };
        }
    });
}

const fullSentence = '你'.repeat(6799) + '。';

test('individual admission has headroom without raising the multi-item batch budget', async () => {
    const boundary = '你'.repeat(7200);
    const small = '好'.repeat(1200);
    const nearChunkLimit = '你'.repeat(5600);
    const tooLong = boundary + '你';
    assert.deepEqual([fullSentence, boundary, small, nearChunkLimit, tooLong].map(getTokenCount), [6800, 7200, 1200, 5600, 7201]);
    const requests = [];
    const result = await embed([nearChunkLimit, small, boundary, tooLong, '末尾'], requests);
    assert.deepEqual(requests.map(batch => batch.map(getTokenCount)), [[5600, 1200], [7200], [getTokenCount('末尾')]]);
    assert.deepEqual(result, [[1, 0], [2, 0], [3, 0], null, [4, 0]]);
});

test('KBM native preparation and admission preserve both small and large overlap boundary cases', async t => {
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(8, 32));
    t.after(() => runtime.shutdown());
    for (const prefix of ['起点。', '测试。'.repeat(300)]) {
        const { chunks } = await manager.prepareIngestionText.call({ nativeKnowledgeRuntime: runtime, config: {} }, prefix + fullSentence);
        assert.equal(chunks[0], prefix);
        assert.ok(chunks.some(chunk => chunk.endsWith(fullSentence)), 'the complete boundary sentence must survive');
        const requests = [];
        const vectors = await embed(chunks, requests);
        assert.deepEqual(requests.flat(), chunks);
        assert.ok(vectors.every(Boolean));
    }
});

test('KBM re-chunks prepared text still over admission instead of trusting its reported token count', async () => {
    const oversized = '测试。'.repeat(300) + fullSentence;
    const nativeKnowledgeRuntime = { prepareText: async raw => {
        assert.equal(JSON.parse(raw).maxTokens, 6800);
        return { chunks: ['短块。', oversized], tokenCount: 1, tags: ['Tag'] };
    } };
    const { chunks, tags } = await manager.prepareIngestionText.call({ nativeKnowledgeRuntime, config: {} }, 'source');
    assert.equal(chunks[0], '短块。');
    assert.ok(chunks.slice(1).join('') === chunkText(oversized).join(''), 're-chunk without truncation');
    assert.deepEqual(tags, ['Tag']);
    assert.ok(chunks.every(chunk => getTokenCount(chunk) <= 6800));
});
