const test = require('node:test');
const assert = require('node:assert/strict');

const ResultDeduplicator = require('../ResultDeduplicator.js');

function vector(values) {
    return new Float32Array(values);
}

function vectorBuffer(values) {
    return Buffer.from(vector(values).buffer);
}

test('hard deduplication normalizes text and keeps the preferred source', async () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    const results = await deduplicator.deduplicate([
        { chunkId: 1, text: '同一段  正文\r\n内容', score: 0.99, source: 'associate' },
        { chunkId: 2, text: '同一段 正文\n内容', score: 0.70, source: 'rag' }
    ], null, { semantic: false });

    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'rag');
    assert.equal(results[0].chunkId, 2);
});

test('hard deduplication handles small candidate sets instead of bypassing them', async () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    const results = await deduplicator.deduplicate([
        { chunkId: 7, text: 'duplicate', score: 0.6, source: 'rag' },
        { chunkId: 7, text: 'duplicate', score: 0.8, source: 'rag' }
    ], null);

    assert.equal(results.length, 1);
    assert.equal(results[0].score, 0.8);
});

test('semantic deduplication suppresses near-identical vectors and keeps distinct memories', async () => {
    const deduplicator = new ResultDeduplicator(null, {
        dimension: 3,
        semanticThreshold: 0.95
    });
    const query = vector([1, 0, 0]);
    const results = await deduplicator.deduplicate([
        { chunkId: 1, text: 'alpha', vector: vector([1, 0, 0]), score: 0.9, source: 'rag' },
        { chunkId: 2, text: 'alpha paraphrase', vector: vector([0.999, 0.02, 0]), score: 0.8, source: 'rag' },
        { chunkId: 3, text: 'beta', vector: vector([0, 1, 0]), score: 0.7, source: 'rag' }
    ], query);

    assert.deepEqual(results.map(result => result.chunkId), [1, 3]);
});

test('missing vectors are hydrated from SQLite-compatible storage before semantic deduplication', async () => {
    const stored = new Map([
        [11, vectorBuffer([1, 0, 0])],
        [12, vectorBuffer([0.999, 0.01, 0])]
    ]);
    const db = {
        prepare(sql) {
            assert.match(sql, /SELECT vector FROM chunks/);
            return {
                get(id) {
                    return stored.has(id) ? { vector: stored.get(id) } : undefined;
                }
            };
        }
    };
    const deduplicator = new ResultDeduplicator(db, {
        dimension: 3,
        semanticThreshold: 0.95
    });

    const results = await deduplicator.deduplicate([
        { chunkId: 11, text: 'stored alpha', score: 0.9, source: 'rag' },
        { chunkId: 12, text: 'stored alpha paraphrase', score: 0.8, source: 'rag' }
    ], vector([1, 0, 0]));

    assert.equal(results.length, 1);
    assert.equal(results[0].chunkId, 11);
    assert.ok(results[0]._vector instanceof Float32Array);
});

test('missing vectors are hydrated in one SQLite batch with unique chunk ids', async () => {
    const stored = new Map([
        [61, vectorBuffer([1, 0, 0])],
        [62, vectorBuffer([0, 1, 0])],
        [63, vectorBuffer([0, 0, 1])]
    ]);
    let prepareCount = 0;
    let allCount = 0;
    let receivedIds = null;
    const db = {
        prepare(sql) {
            prepareCount++;
            assert.match(sql, /SELECT id, vector FROM chunks WHERE id IN/);
            return {
                all(...ids) {
                    allCount++;
                    receivedIds = ids;
                    return ids
                        .filter(id => stored.has(id))
                        .map(id => ({ id, vector: stored.get(id) }));
                }
            };
        }
    };
    const deduplicator = new ResultDeduplicator(db, {
        dimension: 3,
        semanticThreshold: 0.999
    });

    const results = await deduplicator.deduplicate([
        { chunkId: 61, text: 'batch alpha', score: 0.9, source: 'rag' },
        { chunkId: 62, text: 'batch beta', score: 0.8, source: 'rag' },
        { chunkId: 63, text: 'batch gamma', score: 0.7, source: 'rag' }
    ], vector([1, 0, 0]));

    assert.equal(prepareCount, 1);
    assert.equal(allCount, 1);
    assert.deepEqual(receivedIds, [61, 62, 63]);
    assert.equal(results.length, 3);
    assert.ok(results.every(result => result._vector instanceof Float32Array));
});

test('batch hydration deduplicates repeated chunk ids before querying SQLite', () => {
    let receivedIds = null;
    const db = {
        prepare() {
            return {
                all(...ids) {
                    receivedIds = ids;
                    return ids.map(id => ({
                        id,
                        vector: vectorBuffer(id === 71 ? [1, 0, 0] : [0, 1, 0])
                    }));
                }
            };
        }
    };
    const deduplicator = new ResultDeduplicator(db, { dimension: 3 });
    const hydrated = deduplicator._hydrateMissingVectors([
        { chunkId: 71, text: 'first version' },
        { chunkId: 71, text: 'second version' },
        { chunkId: 72, text: 'other chunk' }
    ]);

    assert.deepEqual(receivedIds, [71, 72]);
    assert.ok(hydrated.every(result => result._vector instanceof Float32Array));
});

test('vectorless BM25 and anonymous candidates are preserved safely', async () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    const firstAnonymous = { score: 0.2, source: 'unknown' };
    const secondAnonymous = { score: 0.2, source: 'unknown' };
    const results = await deduplicator.deduplicate([
        { chunkId: 21, text: 'vector result', vector: vector([1, 0, 0]), source: 'rag' },
        { text: 'BM25 only result', score: 2.5, source: 'bm25_body' },
        firstAnonymous,
        secondAnonymous
    ], vector([1, 0, 0]));

    assert.equal(results.length, 4);
    assert.ok(results.includes(firstAnonymous));
    assert.ok(results.includes(secondAnonymous));
    assert.ok(results.some(result => result.source === 'bm25_body'));
});

test('invalid dimensions do not fail the request and remain as vectorless candidates', async () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    const results = await deduplicator.deduplicate([
        { chunkId: 31, text: 'valid', vector: vector([1, 0, 0]), source: 'rag' },
        { chunkId: 32, text: 'wrong dimension', vector: vector([1, 0]), source: 'rag' }
    ], vector([1, 0, 0]));

    assert.equal(results.length, 2);
});

test('semantic failure falls back to exact deduplicated results', async () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    deduplicator._semanticDeduplicate = () => {
        throw new Error('simulated semantic failure');
    };

    const results = await deduplicator.deduplicate([
        { chunkId: 41, text: 'same', vector: vector([1, 0, 0]), score: 0.5, source: 'rag' },
        { chunkId: 41, text: 'same', vector: vector([1, 0, 0]), score: 0.8, source: 'rag' },
        { chunkId: 42, text: 'different', vector: vector([0, 1, 0]), score: 0.7, source: 'rag' }
    ], vector([1, 0, 0]));

    assert.deepEqual(results.map(result => result.chunkId), [41, 42]);
    assert.equal(results[0].score, 0.8);
});

test('runtime config updates semantic threshold and source priorities', async () => {
    const deduplicator = new ResultDeduplicator(null, {
        dimension: 3,
        semanticThreshold: 0.99
    });
    deduplicator.updateConfig({
        semanticThreshold: 0.9,
        sourcePriority: {
            associate: 100
        }
    });

    const results = await deduplicator.deduplicate([
        { chunkId: 51, text: 'preferred associate', vector: vector([1, 0, 0]), score: 0.5, source: 'associate' },
        { chunkId: 52, text: 'similar rag', vector: vector([0.95, 0.1, 0]), score: 0.9, source: 'rag' }
    ], null);

    assert.equal(results.length, 1);
    assert.equal(results[0].chunkId, 52, 'semantic representative selection remains score-first without a query');
    assert.equal(deduplicator.config.sourcePriority.associate, 100);
});

test('prepared cosine path preserves cosine similarity semantics', () => {
    const deduplicator = new ResultDeduplicator(null, { dimension: 3 });
    const left = vector([3, 4, 0]);
    const right = vector([4, 0, 3]);
    const leftDescriptor = deduplicator._createVectorDescriptor(left);
    const rightDescriptor = deduplicator._createVectorDescriptor(right);

    assert.ok(leftDescriptor);
    assert.ok(rightDescriptor);
    assert.equal(
        deduplicator._cosineSimilarityPrepared(leftDescriptor, rightDescriptor),
        deduplicator._cosineSimilarity(left, right)
    );
    assert.ok(
        Math.abs(
            deduplicator._cosineSimilarityPrepared(leftDescriptor, rightDescriptor) - 0.48
        ) < 1e-6
    );
});